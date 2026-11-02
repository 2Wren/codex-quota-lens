#!/usr/bin/env node
// 本地预览：把 chatgpt.com 的页面和接口全部换成夹具数据，打开面板、打印关键文字并截图到 dev/out/。
//
//   node dev/preview.js                  桌面浅色
//   node dev/preview.js --mobile --dark  iPhone 深色
//   node dev/preview.js --no-history     官网历史读取失败，走近似值路径
//   node dev/preview.js --reset          本周期中途用了额度重置卡（可与其他参数组合）
//   node dev/preview.js --settled        同一个账号一天后，官网结算越过了重置时刻
//   node dev/preview.js --month          生成的一个月用量，5 个周期加一次重置，对照真值核对每个周期分到的 credits
//   node dev/preview.js --readme         重新生成 docs/screenshot*.png
//
// 默认夹具按 2026-10-31 的真实诊断信息和 v1.1 的 README 截图重建，时钟固定在那一刻（UTC+8 时区）。
// 每次都会用 ‹ 翻遍所有周期，逐个打印、核对、截图。

const fs = require("fs");
const path = require("path");

let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  console.error("缺少 playwright，先运行：npm i --no-save playwright && npx playwright install chromium");
  process.exit(1);
}

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(__dirname, "out");
const SCRIPT_PATH = path.join(ROOT, "codex-quota-lens.user.js");

const NOW = Date.parse("2026-10-31T06:28:00Z");
const ACCOUNT_ID = "6f2d9c41-8b7e-4a35-9e10-c4a7b2d8e5f3";
const TOKEN = "preview-access-token-0123456789abcdef";
const EMAIL = "preview@example.com";
const sec = (iso) => Math.round(Date.parse(iso) / 1000);

const usage = () => ({
  user_id: "user-PreviewUser00000000000000",
  account_id: "",
  email: EMAIL,
  plan_type: "pro",
  rate_limit: {
    allowed: true,
    limit_reached: true,
    primary_window: {
      used_percent: 100,
      limit_window_seconds: 18000,
      reset_after_seconds: sec("2026-10-31T10:33:00Z") - NOW / 1000,
      reset_at: sec("2026-10-31T10:33:00Z"),
    },
    secondary_window: {
      used_percent: 57,
      limit_window_seconds: 604800,
      reset_after_seconds: sec("2026-11-05T06:13:00Z") - NOW / 1000,
      reset_at: sec("2026-11-05T06:13:00Z"),
    },
  },
  credits: { has_credits: false, unlimited: false, balance: "0" },
  additional_rate_limits: [
    {
      limit_name: "gpt-6.1-sol-spark",
      metered_feature: "codex_spark",
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: { used_percent: 12, limit_window_seconds: 18000, reset_at: sec("2026-10-31T09:05:00Z") },
        secondary_window: { used_percent: 4, limit_window_seconds: 604800, reset_at: sec("2026-11-04T02:40:00Z") },
      },
    },
  ],
});

const rows = (pairs) => pairs.map(([key, basis_points]) => ({ key, basis_points }));

// 当前周 4115 bp = 41.1%，各维度合计都等于它；ends_at 和 wham 的 reset_at 实测差几百毫秒
// 10/29 各模型的 credits：前一部分属于上个周期，后一部分属于本周期（和下面 BREAKDOWN 里 10/29 的合计一致）
const PREV_1029 = { "gpt-6-astra": 620, "gpt-6-sol": 10, "gpt-5.6-luna": 290 };
const CUR_1029 = { "gpt-6-astra": 1317.55, "gpt-6-sol": 332.6, "gpt-5.6-terra": 322.0, "gpt-5.6-luna": 125.0, "gpt-6-luna": 2.97 };
// 同一天里 5 小时窗口的用量和 credits 成正比；取这个比例让 13:05 那个窗口正好是 104.5%
const BP_PER_CREDIT = 10450 / (0.7 * Object.values(CUR_1029).reduce((a, b) => a + b, 0));
const base5h = (start, credits, share, complete) => {
  const entries = Object.entries(credits).map(([m, c]) => [m, c * share * BP_PER_CREDIT]);
  return {
    window_minutes: 300,
    starts_at: start,
    ends_at: new Date(Date.parse(start) + 5 * 3600000).toISOString(),
    used_basis_points: entries.reduce((a, [, v]) => a + v, 0),
    accounting_complete: complete,
    breakdowns: [{ dimension: "model", rows: rows(entries) }],
  };
};

const history = () => ({
  data_as_of: "2026-10-31T00:00:00Z",
  periods: [
    {
      window_minutes: 10080,
      starts_at: "2026-10-29T06:12:59.612Z",
      ends_at: "2026-11-05T06:12:59.612Z",
      used_basis_points: 4115,
      accounting_complete: false,
      breakdowns: [
        {
          dimension: "model",
          rows: rows([
            ["gpt-6-astra", 2698],
            ["gpt-6-sol", 498],
            ["gpt-6.1-sol", 441],
            ["gpt-5.6-terra", 331],
            ["gpt-5.6-luna", 128],
            ["gpt-6.1-sol-wm", 16],
            ["gpt-6-luna", 3],
          ]),
        },
        {
          dimension: "thread_source",
          rows: rows([
            ["user", 3862],
            ["memory_consolidation", 205],
            ["thread_title", 31],
            ["ambient_suggestions", 17],
          ]),
        },
        { dimension: "turn_trigger", rows: rows([["user_message", 3893], ["background", 222]]) },
        {
          dimension: "surface",
          rows: rows([
            ["cli", 2384],
            ["vscode", 1546],
            ["web", 169],
            ["work_mobile", 16],
          ]),
        },
      ],
    },
    {
      window_minutes: 10080,
      starts_at: "2026-10-22T06:12:59.208Z",
      ends_at: "2026-10-29T06:12:59.208Z",
      used_basis_points: 9620,
      accounting_complete: true,
      breakdowns: [{ dimension: "model", rows: rows([["gpt-6-astra", 6120], ["gpt-6-sol", 2210], ["gpt-5.6-luna", 1290]]) }],
    },
    {
      window_minutes: 300,
      starts_at: "2026-10-30T09:41:12Z",
      ends_at: "2026-10-30T14:41:12Z",
      used_basis_points: 7180,
      accounting_complete: true,
      breakdowns: [],
    },
    // 10/29 跨两个周期，脚本按这几个窗口的分模型用量拆：上个周期一个窗口，本周期两个（3:7）
    base5h("2026-10-29T00:48:20Z", PREV_1029, 1, true),
    base5h("2026-10-29T06:15:02Z", CUR_1029, 0.3, true),
    // 用超 100% 的 5 小时窗口，结束一天多了仍是 accounting_complete: false
    base5h("2026-10-29T13:05:40Z", CUR_1029, 0.7, false),
  ],
});

const tokens = (input, cached, output) => ({
  uncached_text_input_tokens: input,
  cached_text_input_tokens: cached,
  text_output_tokens: output,
  text_total_tokens: input + cached + output,
});
// totals.credits 是绝对值；models[] 里没有 Token，credits 也全是 0
const counts = (date, credits, input, cached, output) => ({
  date,
  totals: { users: 1, credits, ...tokens(input, cached, output) },
  models: [{ model: "gpt-6-astra", credits: 0, users: 1 }],
});
// 每日 breakdown 这里先写成绝对 credits，返回前再按区间归一化成相对值
const day = (date, models, surfaces) => {
  const total = Object.values(models).reduce((a, b) => a + b, 0);
  return {
    attribution: [],
    date,
    models: Object.entries(models).map(([key, credits]) => {
      const [model, speed = "standard"] = key.split(":");
      return { model, speed, credits };
    }),
    product_surface_usage_values: surfaces || { desktop_app: total },
  };
};

// 上个周期 10/22–10/29 合计 9620 credits，对应官网 96.2%，所以 Pro 每 1% 合 100 credits。
// 10/29 跨两个周期：前 920 credits（astra 620、6-sol 10、luna 290）属于上个周期，其余属于本周期
const BREAKDOWN = [
  day("2026-10-22", { "gpt-6-astra": 800, "gpt-6-sol": 300, "gpt-5.6-luna": 100 }, { cli: 900, vscode: 300 }),
  day("2026-10-23", { "gpt-6-astra": 1000, "gpt-6-sol": 350, "gpt-5.6-luna": 150 }, { cli: 1100, vscode: 400 }),
  day("2026-10-24", { "gpt-6-astra": 500, "gpt-6-sol": 250, "gpt-5.6-luna": 150 }, { cli: 600, vscode: 300 }),
  day("2026-10-26", { "gpt-6-astra": 1100, "gpt-6-sol": 400, "gpt-5.6-luna": 300 }, { cli: 1200, vscode: 600 }),
  day("2026-10-27", { "gpt-6-astra": 1300, "gpt-6-sol": 500, "gpt-5.6-luna": 300 }, { cli: 1400, vscode: 700 }),
  day("2026-10-28", { "gpt-6-astra": 800, "gpt-6-sol": 400 }, { cli: 800, vscode: 400 }),
  day(
    "2026-10-29",
    {
      "gpt-6-astra": 1907.9,
      "gpt-6-astra:fast": 29.65,
      "gpt-6-sol": 342.6,
      "gpt-5.6-terra-2026-06-18": 322.0,
      "gpt-5.6-luna": 415.0,
      "gpt-6-luna": 2.97,
    },
    { cli: 1780, vscode: 1126, web: 114 },
  ),
  day(
    "2026-10-30",
    { "gpt-6-astra": 1386.0, "gpt-6.1-sol": 446.4, "gpt-6.1-sol:fast": 6.22, "gpt-6.1-sol-wm": 16.44, "gpt-6-sol": 159.9 },
    { cli: 1150, vscode: 810, web: 39, work_mobile: 16 },
  ),
];

// 10/25 没有用量，counts 接口那天干脆没返回
const TOTALS = [
  counts("2026-10-22", 1200, 842310, 10917455, 241027),
  counts("2026-10-23", 1500, 1051877, 13648210, 300561),
  counts("2026-10-24", 900, 628102, 8191334, 179880),
  counts("2026-10-26", 1800, 1262415, 16377092, 360911),
  counts("2026-10-27", 2100, 1468230, 19113871, 419204),
  counts("2026-10-28", 1200, 838416, 10925008, 238770),
  counts("2026-10-29", 3020, 2194773, 27761902, 548861),
  counts("2026-10-30", 2015, 1207330, 18295770, 297940),
];

const resetCredits = () => ({
  credits: [
    {
      id: "rrc_PreviewResetCard00000000000000000000000000000000",
      reset_type: "codex_rate_limits",
      is_supported_by_plan: true,
      status: "available",
      granted_at: "2026-11-01T21:58:47.488605Z",
      expires_at: "2026-12-01T21:58:47.488605Z",
      redeem_started_at: null,
      redeemed_at: null,
      profile_image_url: "https://assets.example.com/codex/preview-avatar.png?user=preview-user",
      profile_user_id: "preview001",
      title: "完全重置（每周 + 5 小时）",
      description: "感谢使用 Codex！你已获赠一次免费的速率限制重置机会。",
    },
  ],
  available_count: 1,
  total_earned_count: 0,
  immediate_reset_purchase_eligible: false,
  history_enabled: true,
});

const BASE = { now: NOW, usage, history, breakdown: BREAKDOWN, totals: TOTALS };

// 用了额度重置卡的场景，按 2026-11-02 05:40Z 的真实诊断信息：11/1 05:12Z 用卡，wham 已经换成新周期（实时 15%），
// 官网历史只结算到 11/1 00:00，里面还留着旧周期，ends_at 仍是原来的 11/5，用量 88.5%。
// 11/1 合计约 341 credits（脚本当时拆成旧周期 106、新周期 235），各模型怎么分是编的；11/2 counts 接口还没有这一天。
const RESET_NOW = Date.parse("2026-11-02T05:40:51.592Z");
const resetUsage = () => ({
  user_id: "user-PreviewUser0000000000000",
  account_id: "",
  email: EMAIL,
  plan_type: "plus",
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: { used_percent: 0, limit_window_seconds: 18000, reset_after_seconds: 18000, reset_at: 1793616048 },
    secondary_window: { used_percent: 15, limit_window_seconds: 604800, reset_after_seconds: 516716, reset_at: 1794114763 },
  },
  code_review_rate_limit: null,
  additional_rate_limits: null,
  credits: { has_credits: false, unlimited: false, overage_limit_reached: false, balance: "0" },
  rate_limit_reached_type: null,
  rate_limit_reset_credits: { available_count: 1, applicable_available_count: 0 },
});
const p5 = (start, end, used, complete, models) => ({
  window_minutes: 300,
  plan_type: "plus",
  starts_at: start,
  ends_at: end,
  accounting_complete: complete,
  used_basis_points: used,
  breakdowns: [{ dimension: "model", rows: rows(models) }],
});
const resetHistory = () => ({
  data_as_of: "2026-11-01T00:00:00Z",
  coverage_start: "2026-10-02T00:00:00Z",
  coverage_complete: false,
  approximate: true,
  boundary_tolerance_seconds: 60,
  periods: [
    p5("2026-10-31T16:29:35.335000Z", "2026-10-31T21:29:35.335000Z", 9991.158028, true, [["gpt-5.6-terra", 249.104868], ["gpt-6.1-sol", 9742.05316]]),
    p5("2026-10-31T10:33:55.965000Z", "2026-10-31T15:33:55.965000Z", 10107.06634, false, [["gpt-6.1-sol", 10107.06634]]),
    p5("2026-10-31T05:33:08.006000Z", "2026-10-31T10:33:08.006000Z", 10227.820941, false, [
      ["gpt-5.6-luna", 230.9316372], ["gpt-5.6-terra", 688.247064], ["gpt-6-luna", 21.658688], ["gpt-6.1-sol", 9286.983552],
    ]),
    p5("2026-10-30T09:13:28.553000Z", "2026-10-30T14:13:28.553000Z", 4336.825848, true, [
      ["gpt-5.6-luna", 42.7500516], ["gpt-5.6-terra", 425.623284], ["gpt-6-astra", 443.064], ["gpt-6-sol", 2830.97108], ["gpt-6.1-sol", 594.417432],
    ]),
    p5("2026-10-30T01:31:18.947000Z", "2026-10-30T06:31:18.947000Z", 2064.764508, true, [
      ["gpt-5.6-luna", 45.3688524], ["gpt-5.6-terra", 793.244184], ["gpt-6.1-sol", 1122.571604], ["gpt-6.1-sol-wm", 103.579868],
    ]),
    p5("2026-10-29T16:57:23.602000Z", "2026-10-29T21:57:23.602000Z", 10012.343312, false, [
      ["gpt-5.6-luna", 575.5824636], ["gpt-5.6-terra", 582.3615], ["gpt-6-astra", 8249.57], ["gpt-6-luna", 14.306016], ["gpt-6-sol", 381.545752], ["gpt-6.1-sol", 208.97758],
    ]),
    p5("2026-10-29T06:13:11.484000Z", "2026-10-29T11:13:11.484000Z", 9919.308847, true, [
      ["gpt-5.6-luna", 149.7803808], ["gpt-5.6-terra", 281.699796], ["gpt-6-astra", 8587.346], ["gpt-6-luna", 32.413216], ["gpt-6.1-sol", 868.069454],
    ]),
    {
      window_minutes: 10080,
      plan_type: "plus",
      starts_at: "2026-10-29T06:13:03.828000Z",
      ends_at: "2026-11-05T06:13:03.828000Z",
      accounting_complete: false,
      used_basis_points: 8853.013722,
      breakdowns: [
        {
          dimension: "model",
          rows: rows([
            ["gpt-5.6-luna", 163.1895915], ["gpt-5.6-terra", 471.91885875], ["gpt-6-astra", 2699.996875], ["gpt-6-luna", 10.68405],
            ["gpt-6-sol", 501.955755], ["gpt-6.1-sol", 4989.0842378125], ["gpt-6.1-sol-wm", 16.184354375],
          ]),
        },
        {
          dimension: "thread_source",
          rows: rows([
            ["ambient_suggestions", 7.95831], ["memory_consolidation", 635.10845025], ["subagent", 2720.856560625],
            ["thread_title", 1.745], ["unknown", 859.5127578125], ["user", 4626.85190375],
          ]),
        },
        { dimension: "surface", rows: rows([["desktop_app", 8756.2601236875], ["work_mobile", 96.75359875]]) },
      ],
    },
  ],
});
// 绝对 credits；10/29–10/31 按真实 totals.credits 和当天 5 小时窗口的模型占比拆；11/1 官网结算后看到只有 6.1-sol 和一点 6-luna
const RESET_BREAKDOWN = [
  day("2026-10-29", { "gpt-6-astra": 428.2, "gpt-6.1-sol": 20.82, "gpt-6.1-sol:fast": 6.7, "gpt-6-sol": 10.94, "gpt-5.6-terra": 22.0, "gpt-5.6-luna": 18.5, "gpt-6-luna": 1.155 }),
  day("2026-10-30", { "gpt-6-sol": 70.9, "gpt-6.1-sol": 43.0, "gpt-5.6-terra": 30.53, "gpt-6-astra": 11.1, "gpt-6.1-sol-wm": 2.59, "gpt-5.6-luna": 2.204 }),
  day("2026-10-31", { "gpt-6.1-sol": 689.14, "gpt-5.6-terra": 22.17, "gpt-5.6-luna": 5.46, "gpt-6-luna": 0.51 }),
  day("2026-11-01", { "gpt-6.1-sol": 340.7, "gpt-6-luna": 0.4 }),
];
const RESET_TOTALS = [
  counts("2026-10-29", 508.315009, 3261897, 16150144, 279658),
  counts("2026-10-30", 160.32435, 984171, 20175872, 130318),
  counts("2026-10-31", 717.28254, 4913094, 172611072, 350110),
  counts("2026-11-01", 341.1, 2163390, 54932608, 142107),
];
const RESET = { now: RESET_NOW, usage: resetUsage, history: resetHistory, breakdown: RESET_BREAKDOWN, totals: RESET_TOTALS };

// 同一个 Plus 账号在 2026-11-02 06:06Z 的诊断：官网结算到了 11/2 00:00。
// 旧周期的 ends_at 改成了重置时刻 05:12:03.281（带毫秒），最终 100.09%；新周期 40 秒后第一次使用才开始，已结算 14.66%。
// 5 小时窗口也在重置时刻截断。11/1 合计 341.3 credits，按窗口拆应是旧周期约 150、新周期约 191
const settledUsage = () => {
  const u = resetUsage();
  u.rate_limit.primary_window = { used_percent: 0, limit_window_seconds: 18000, reset_after_seconds: 18000, reset_at: 1793617567 };
  u.rate_limit.secondary_window = { used_percent: 15, limit_window_seconds: 604800, reset_after_seconds: 515197, reset_at: 1794114763 };
  return u;
};
const settledHistory = () => {
  const h = resetHistory();
  const old = h.periods.find((p) => p.window_minutes === 10080);
  Object.assign(old, { ends_at: "2026-11-01T05:12:03.281000Z", used_basis_points: 10008.525453 });
  old.breakdowns[0].rows.find((r) => r.key === "gpt-6.1-sol").basis_points = 6144.5959684375;
  return {
    ...h,
    data_as_of: "2026-11-02T00:00:00Z",
    coverage_start: "2026-10-03T00:00:00Z",
    periods: [
      p5("2026-11-01T12:36:09.620000Z", "2026-11-01T17:36:09.620000Z", 234.808308, true, [["gpt-6.1-sol", 234.808308]]),
      p5("2026-11-01T05:12:43.830000Z", "2026-11-01T10:12:43.830000Z", 9150.373544, true, [["gpt-6-luna", 13.923648], ["gpt-6.1-sol", 9136.449896]]),
      {
        window_minutes: 10080,
        plan_type: "plus",
        starts_at: "2026-11-01T05:12:43.829000Z",
        ends_at: "2026-11-08T05:12:43.829000Z",
        accounting_complete: true,
        used_basis_points: 1466.434664,
        breakdowns: [
          { dimension: "model", rows: rows([["gpt-6-luna", 2.17557], ["gpt-6.1-sol", 1464.259094375]]) },
          { dimension: "thread_source", rows: rows([["ambient_suggestions", 2.00369], ["subagent", 869.749260625], ["user", 594.50983375]]) },
        ],
      },
      p5("2026-11-01T02:32:50.715000Z", "2026-11-01T05:12:03.281000Z", 7395.275076, false, [["gpt-6.1-sol", 7395.275076]]),
      ...h.periods,
    ],
  };
};
const SETTLED = {
  now: Date.parse("2026-11-02T06:06:14.918Z"),
  usage: settledUsage,
  history: settledHistory,
  breakdown: [...RESET_BREAKDOWN.slice(0, 3), day("2026-11-01", { "gpt-6.1-sol": 340.9, "gpt-6-luna": 0.4 })],
  totals: [...RESET_TOTALS.slice(0, 3), counts("2026-11-01", 341.3, 3405212, 86512640, 198016)],
};

// 生成一个月的用量，周期、5 小时窗口和官网历史都按真实规则推出来，用来核对脚本算出的每个周期 credits。
// 每 100% 周额度合 2000 credits；10/27 15:30 用了重置卡；最早那个周期从 9 月底开始，只有一部分在 30 天明细里。
// 按 2026-11-02 的诊断：重置后要等下一次使用才开始新窗口；结算越过重置时刻后，旧窗口的 ends_at 改成重置时刻；
// credits 和额度的比例每天不一样（实测相差近 20%），这里每天随机浮动 ±15%
const MONTH = (() => {
  const now = Date.parse("2026-11-02T04:40:00Z");
  const asOf = Date.parse("2026-11-01T00:00:00Z");
  const resetAt = Date.parse("2026-10-27T15:30:00Z");
  const Q = 2000;
  const Q5 = 300;
  const H = 3600000;
  const WEEK = 7 * 86400000;
  const FIVE = 5 * H;
  // 脚本查的 30 天明细从这天开始
  const firstDay = Date.parse("2026-10-04T00:00:00Z");
  let seed = 20261102;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const MODELS = [["gpt-6.1-sol", 0.5], ["gpt-6-astra", 0.3], ["gpt-5.6-terra", 0.15], ["gpt-5.6-luna", 0.05]];

  // 每天两段：UTC 上午一段、下午一段，有的天休息
  const events = [];
  const factor = new Map();
  for (let day = Date.parse("2026-09-27T00:00:00Z"); day < now; day += 86400000) {
    factor.set(day, 0.85 + rand() * 0.3);
    if (rand() < 0.15) continue;
    const sessions = [[Math.floor(rand() * 8), 3 + Math.floor(rand() * 3)], [10 + Math.floor(rand() * 7), 2 + Math.floor(rand() * 4)]];
    sessions.forEach(([from, len]) => {
      for (let h = from; h < from + len; h += 1) {
        const t = day + h * H + Math.floor(rand() * 50) * 60000;
        if (t >= now) continue;
        const total = 8 + rand() * 30;
        const w = MODELS.map(([m, p]) => [m, p * (0.5 + rand())]);
        const wt = w.reduce((a, [, x]) => a + x, 0);
        events.push({ t, f: factor.get(day), models: Object.fromEntries(w.map(([m, x]) => [m, (total * x) / wt])) });
      }
    });
  }
  events.sort((a, b) => a.t - b.t);

  // 窗口从第一次使用开始计时；重置卡让两种窗口都立刻结束，等下次使用再开始
  const weeks = [];
  const fives = [];
  let week = null;
  let five = null;
  let resetDone = false;
  // models 是 credits（真值），quota 是折成额度的用量，settled 是其中结算到 data_as_of 的部分
  const open = (list, start) => {
    const w = { start, cutAt: NaN, models: {}, quota: {}, settled: {}, recent: {} };
    list.push(w);
    return w;
  };
  const add = (w, e) =>
    Object.entries(e.models).forEach(([m, c]) => {
      w.models[m] = (w.models[m] || 0) + c;
      w.quota[m] = (w.quota[m] || 0) + c * e.f;
      if (e.t < asOf) w.settled[m] = (w.settled[m] || 0) + c * e.f;
      if (e.t >= firstDay) w.recent[m] = (w.recent[m] || 0) + c;
    });
  events.forEach((e) => {
    if (!resetDone && e.t >= resetAt) {
      resetDone = true;
      if (week && week.start + WEEK > resetAt) week.cutAt = resetAt;
      if (five && five.start + FIVE > resetAt) five.cutAt = resetAt;
      week = null;
      five = null;
    }
    if (!week || e.t >= week.start + WEEK) week = open(weeks, e.t);
    if (!five || e.t >= five.start + FIVE) five = open(fives, e.t);
    add(week, e);
    add(five, e);
  });

  const total = (o) => Object.values(o).reduce((a, b) => a + b, 0);
  const iso = (ms) => new Date(ms).toISOString();
  const period = (w, minutes, q) => ({
    window_minutes: minutes,
    plan_type: "plus",
    starts_at: iso(w.start),
    ends_at: w.cutAt <= asOf ? iso(w.cutAt).replace(".000Z", "Z") : iso(w.start + minutes * 60000),
    accounting_complete: w.start + minutes * 60000 <= asOf,
    used_basis_points: (total(w.settled) / q) * 10000,
    breakdowns: [
      { dimension: "model", rows: rows(Object.entries(w.settled).map(([m, c]) => [m, (c / q) * 10000])) },
      { dimension: "thread_source", rows: rows([["user", (total(w.settled) / q) * 10000]]) },
    ],
  });
  const seen = (w, len) => w.start < asOf && w.start + len > now - 30 * 86400000;

  const byDay = new Map();
  events.forEach((e) => {
    const date = iso(e.t).slice(0, 10);
    const d = byDay.get(date) || {};
    Object.entries(e.models).forEach(([m, c]) => (d[m] = (d[m] || 0) + c));
    byDay.set(date, d);
  });
  const breakdown = [...byDay].map(([date, models]) => day(date, models));
  const totals = [...byDay].map(([date, models]) => {
    const c = total(models);
    return counts(date, c, Math.round(c * 720), Math.round(c * 8100), Math.round(c * 180));
  });

  const live = (w, len, q) => {
    const active = w && now < w.start + len;
    return {
      used_percent: active ? Math.round((total(w.quota) / q) * 100) : 0,
      limit_window_seconds: len / 1000,
      reset_after_seconds: active ? Math.round((w.start + len - now) / 1000) : len / 1000,
      reset_at: Math.round((active ? w.start + len : now + len) / 1000),
    };
  };

  return {
    now,
    usage: () => ({
      ...resetUsage(),
      rate_limit: { allowed: true, limit_reached: false, primary_window: live(five, FIVE, Q5), secondary_window: live(week, WEEK, Q) },
    }),
    history: () => ({
      data_as_of: iso(asOf),
      coverage_start: "2026-10-02T00:00:00Z",
      approximate: true,
      boundary_tolerance_seconds: 60,
      periods: [
        ...weeks.filter((w) => seen(w, WEEK)).map((w) => period(w, 10080, Q)),
        ...fives.filter((w) => seen(w, FIVE)).map((w) => period(w, 300, Q5)),
      ].sort((a, b) => b.starts_at.localeCompare(a.starts_at)),
    }),
    breakdown,
    totals,
    // 每个周期实际用了多少 credits（含还没结算的），对照脚本的拆分结果；明细不全的周期只比 30 天内那部分
    truth: weeks.map((w) => ({ start: w.start, credits: total(w.models), recent: total(w.recent), cut: Number.isFinite(w.cutAt) })),
  };
})();

const inRange = (list, url) => {
  const from = url.searchParams.get("start_date") || "0000-00-00";
  const to = url.searchParams.get("end_date") || "9999-99-99";
  return list.filter((r) => r.date >= from && r.date <= to);
};

// breakdown 接口没有用量的日子也会返回，数值全是 0
const fillDays = (list, url) => {
  const from = url.searchParams.get("start_date");
  const to = url.searchParams.get("end_date");
  if (!from || !to) return inRange(list, url);
  const byDate = new Map(list.map((r) => [r.date, r]));
  const out = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86400000) {
    const date = new Date(t).toISOString().slice(0, 10);
    out.push(byDate.get(date) || { attribution: [], date, models: [], product_surface_usage_values: {} });
  }
  return out;
};

// 实测 credits 是相对值：查询区间里用量最多的那天合计为 100
const normalize = (list) => {
  const dayTotal = (r) => r.models.reduce((a, m) => a + m.credits, 0);
  const max = Math.max(0, ...list.map(dayTotal)) || 1;
  return list.map((r) => ({
    ...r,
    models: r.models.map((m) => ({ ...m, credits: (m.credits / max) * 100 })),
    product_surface_usage_values: Object.fromEntries(
      Object.entries(r.product_surface_usage_values).map(([k, v]) => [k, (v / max) * 100]),
    ),
  }));
};

function backend(url, headers, opts) {
  const p = url.pathname;
  const S = opts.scenario;
  if (headers.authorization !== `Bearer ${TOKEN}`) return [401, { detail: "Unauthorized" }];
  if (p === "/backend-api/wham/usage") return [200, S.usage()];
  if (p === "/backend-api/wham/accounts/check") {
    return [200, { default_account_id: ACCOUNT_ID, accounts: [{ id: ACCOUNT_ID, plan_type: "pro", account_user_role: "account-owner" }] }];
  }
  if (p === "/backend-api/wham/usage/plan_limit_history") {
    if (opts.noHistory || headers["chatgpt-account-id"] !== ACCOUNT_ID) {
      return [400, { detail: "Unable to scope allowance history to the authenticated account" }];
    }
    return [200, S.history()];
  }
  if (p === "/backend-api/wham/usage/daily-workspace-user-token-usage-breakdown") return [400, { detail: "No active workspace found" }];
  if (p === "/backend-api/wham/usage/daily-token-usage-breakdown") return [200, { units: "percent", data: normalize(fillDays(S.breakdown, url)) }];
  if (p === "/backend-api/wham/analytics/daily-workspace-usage-counts") return [200, { data: inRange(S.totals, url), balance_unit: "credit", group_by: "day" }];
  if (p === "/backend-api/wham/rate-limit-reset-credits") return [200, resetCredits()];
  return [404, { detail: "Not Found" }];
}

const stubPage = (dark) => `<!doctype html>
<html lang="zh-CN" class="${dark ? "dark" : "light"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ChatGPT</title>
<style>
  body { margin: 0; font: 15px/1.5 -apple-system, "PingFang SC", sans-serif; background: ${dark ? "#212121" : "#ffffff"}; color: ${dark ? "#ececec" : "#0d0d0d"}; }
  main { max-width: 720px; margin: 0 auto; padding: 48px 24px; }
  .bar { height: 12px; margin: 14px 0 28px; border-radius: 6px; background: ${dark ? "#333" : "#eee"}; }
  .bar.short { width: 60%; }
</style>
</head>
<body><main><h1>用量</h1><div class="bar"></div><div class="bar short"></div><div class="bar"></div></main></body>
</html>`;

const VIEW_HOOK = "const view = buildView(state.data, state.index);";

// 在页面里运行：面板上的关键文字，加上 buildView 的结果用来核对
const summarize = () => {
  const root = document.getElementById("cql-root");
  const text = (el) => (el ? el.innerText.replace(/\s+/g, " ").trim() : "");
  const all = (sel) => [...root.querySelectorAll(sel)].map(text);
  const v = window.__cqlView;
  return {
    head: text(root.querySelector(".ql-head p")),
    num: text(root.querySelector(".ql-num")),
    pace: text(root.querySelector(".ql-pace")),
    legend: all(".ql-key"),
    short: text(root.querySelector(".ql-short")),
    figures: all(".ql-figure"),
    notices: all(".ql-notice"),
    models: [...root.querySelectorAll("button.ql-row")].map((r) =>
      [...r.children].slice(1).map((c) => text(c).replace(/(Fast|Ultrafast)$/, " $1")).join("  "),
    ),
    total: [...(root.querySelector(".ql-row-total")?.children || [])].slice(1).map(text).join("  "),
    folds: all(".ql-fold > summary"),
    check: v
      ? {
          current: v.current,
          settled: v.settled,
          hasSettled: v.hasSettled,
          live: v.live,
          quotaApprox: v.quotaApprox,
          quotaTotal: v.quotaTotal,
          quotaSum: v.models.reduce((a, m) => a + m.quota, 0),
        }
      : null,
  };
};

async function shoot(opts) {
  const { mobile, dark, tag } = opts;
  const source = fs.readFileSync(SCRIPT_PATH, "utf8");
  if (!source.includes(VIEW_HOOK)) console.warn(`找不到「${VIEW_HOOK}」，无法核对模型合计`);
  const script = source.replace(VIEW_HOOK, `${VIEW_HOOK} window.__cqlView = view;`);

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
    deviceScaleFactor: mobile ? 3 : 2,
    isMobile: mobile,
    hasTouch: mobile,
    colorScheme: dark ? "dark" : "light",
    reducedMotion: "reduce",
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
  });
  const requests = [];
  await context.route("https://chatgpt.com/**", (route, request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/backend-api/")) {
      const [status, body] = backend(url, request.headers(), opts);
      requests.push(`${status} ${url.pathname}${url.search}`);
      return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    }
    if (url.pathname === "/api/auth/session") {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ accessToken: TOKEN, user: { email: EMAIL } }) });
    }
    return route.fulfill({ contentType: "text/html; charset=utf-8", body: stubPage(dark) });
  });

  // 只固定 Date；page.clock 会连 performance.getEntriesByType 一起换掉，诊断信息就读不到请求记录了
  await context.addInitScript((now) => {
    const RealDate = Date;
    class FixedDate extends RealDate {
      constructor(...args) {
        super(...(args.length ? args : [now]));
      }
      static now() {
        return now;
      }
    }
    globalThis.Date = FixedDate;
  }, opts.scenario.now);

  const page = await context.newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(`页面异常：${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error" && m.type() !== "warning") return;
    const where = m.location()?.url ? `（${new URL(m.location().url).pathname}）` : "";
    problems.push(`console.${m.type()}：${m.text()}${where}`);
  });

  await page.goto("https://chatgpt.com/settings/usage");
  await page.addScriptTag({ content: script });
  await page.click("#cql-launch");
  await page.waitForSelector("#cql-root .ql-num, #cql-root .ql-retry");

  const views = [{ label: "本周期", ...(await page.evaluate(summarize)) }];

  fs.mkdirSync(OUT, { recursive: true });
  const saved = [];
  const save = async (name, fn) => {
    const file = opts.files?.[name] || path.join(OUT, `${tag}-${name}.png`);
    await fn(file);
    saved.push(path.relative(ROOT, file));
  };

  // 让视口刚好容下整个面板，再对面板单独截图
  const fullPanel = async (file) => {
    const height = await page.evaluate(() => document.getElementById("cql-root").scrollHeight);
    const margin = mobile ? 8 : 24;
    await page.setViewportSize({ width: page.viewportSize().width, height: height + margin * 2 });
    await page.waitForFunction(() => {
      const r = document.getElementById("cql-root");
      return r.scrollHeight <= r.clientHeight + 1;
    });
    await page.locator("#cql-root").screenshot({ path: file, animations: "disabled" });
  };
  const OLDER = "#cql-root [data-act=older]:not(:disabled)";
  const NEWER = "#cql-root [data-act=newer]:not(:disabled)";

  if (!opts.files) await save("viewport", (file) => page.screenshot({ path: file }));
  await save("panel", fullPanel);

  let diag = null;
  if (!opts.files) {
    // 用 ‹ 一路翻到最早的周期，每个都看一遍，再用 › 翻回来
    for (let k = 1; await page.$(OLDER); k += 1) {
      await page.click(OLDER);
      views.push({ label: `往前第 ${k} 个周期`, ...(await page.evaluate(summarize)) });
      await save(`older${k > 1 ? k : ""}-panel`, fullPanel);
    }
    while (await page.$(NEWER)) await page.click(NEWER);

    await page.evaluate(() => {
      const root = document.getElementById("cql-root");
      root.querySelectorAll("details.ql-fold").forEach((d) => (d.open = true));
      root.querySelectorAll("button.ql-row").forEach((b, i) => i < 2 && b.click());
    });
    await page.click("#cql-root [data-act=diag]");
    await page.waitForFunction(() => document.querySelector("#cql-root .ql-diag textarea")?.value);
    diag = await page.$eval("#cql-root .ql-diag textarea", (t) => t.value);
    const diagFile = path.join(OUT, `${tag}-diag.json`);
    fs.writeFileSync(diagFile, diag);
    saved.push(path.relative(ROOT, diagFile));
    await save("open", fullPanel);

    // 折叠状态记在 localStorage 里，翻到上个周期时也是展开的
    if (await page.$(OLDER)) {
      await page.click(OLDER);
      await save("older-open", fullPanel);
    }
  }

  await browser.close();
  return { views, requests, problems, saved, diag };
}

function reportView(s) {
  console.log(`\n--- ${s.label} ---`);
  console.log(`页眉    ${s.head}`);
  console.log(`主数字  ${s.num}   ${s.pace}`);
  console.log(`图例    ${s.legend.join(" ／ ")}`);
  if (s.short) console.log(`短窗口  ${s.short}`);
  console.log(`数字    ${s.figures.join(" ／ ")}`);
  s.notices.forEach((t) => console.log(`提示    ${t}`));
  console.log("模型");
  s.models.forEach((t) => console.log(`  ${t}`));
  console.log(`  ${s.total}`);
  console.log(`折叠    ${s.folds.join(" ／ ")}`);

  if (!s.check) return;
  const { current, settled, hasSettled, live, quotaApprox, quotaTotal, quotaSum } = s.check;
  // 有官网模型数据时合计应等于已结算；近似时等于已结算（大于 0 时）或实时
  const target = quotaApprox ? (hasSettled && settled > 1e-9 ? settled : live) : settled;
  const label = quotaApprox ? (hasSettled && settled > 1e-9 ? "已结算（近似）" : "实时（近似）") : "已结算";
  const ok = Math.abs(quotaSum - target) < 1e-6 && Math.abs(quotaTotal - target) < 1e-6;
  console.log(`核对    模型占周额度合计 ${(quotaSum * 100).toFixed(3)}%，${label} ${(target * 100).toFixed(3)}%  ${ok ? "一致" : "不一致！"}`);
  if (!ok) process.exitCode = 1;
  // wham 的 used_percent 是整数，允许 1% 的误差
  if (current && hasSettled && settled > live + 0.01) {
    console.log(`核对    已结算 ${(settled * 100).toFixed(1)}% 高于实时 ${(live * 100).toFixed(1)}%，周期很可能匹配错了！`);
    process.exitCode = 1;
  }
}

function report(label, { views, requests, problems, saved, diag }, opts) {
  console.log(`\n=== ${label} ===`);
  views.forEach(reportView);
  console.log("");

  if (diag) {
    const leaks = [ACCOUNT_ID, TOKEN, EMAIL].filter((secret) => diag.includes(secret));
    console.log(`诊断    ${diag.length} 字符，${leaks.length ? `泄露了 ${leaks.join("、")}！` : "没有泄露账号 ID、凭证和邮箱"}`);
    if (leaks.length) process.exitCode = 1;
    const computed = JSON.parse(diag).computed;
    if (computed) {
      const unit = computed.unit === "credits" ? "credits" : "（相对值）";
      console.log(`换算    每 100% 周额度 ${computed.per100 ?? "—"} ${unit}`);
      computed.cycles.forEach((c) => {
        const truth = computed.unit === "credits" && opts.scenario?.truth?.find((t) => Math.abs(t.start - Date.parse(c.start)) < 60000);
        const real = truth && (c.partial ? truth.recent : truth.credits);
        const diff = real > 0 ? `差 ${(((c.amount - real) / real) * 100).toFixed(1)}%` : `差 ${(c.amount - real).toFixed(1)}`;
        const versus = truth ? `（实际${c.partial ? "（30 天内）" : ""} ${Math.round(real)}，${diff}）` : "";
        console.log(`  ${c.start.slice(5, 16)} – ${c.end.slice(5, 16)}  ${c.settled ?? "—"}%${c.cut ? " 提前重置" : ""}${c.partial ? " 明细不全" : ""}  ${c.amount} ${unit}${versus}`);
        const shared = c.days.filter((d) => d.includes(" "));
        if (shared.length) console.log(`      跨周期：${shared.join("，")}`);
      });
    }
  }

  console.log("请求");
  requests.forEach((r) => console.log(`  ${r}`));
  // 个人账号先探测 Team 接口拿到 400 是正常流程；--no-history 时历史接口失败也在预期内
  const expected = [/daily-workspace-user-token-usage-breakdown/];
  if (opts.noHistory) expected.push(/plan_limit_history|读取官网限额历史失败/);
  const real = problems.filter((p) => !expected.some((re) => re.test(p)));
  if (real.length) {
    console.log("页面报错");
    real.forEach((p) => console.log(`  ${p}`));
    process.exitCode = 1;
  } else {
    console.log(`页面报错  无${problems.length ? `（${problems.length} 条在预期内）` : ""}`);
  }
  console.log(`截图    ${saved.join("  ")}`);
}

(async () => {
  const args = new Set(process.argv.slice(2));
  if (args.has("--readme")) {
    for (const dark of [false, true]) {
      const file = path.join(ROOT, "docs", dark ? "screenshot-dark.png" : "screenshot.png");
      const result = await shoot({ mobile: false, dark, tag: "readme", scenario: BASE, files: { panel: file } });
      report(dark ? "README 深色" : "README 浅色", result, {});
    }
    return;
  }
  const name = ["reset", "settled", "month"].find((k) => args.has(`--${k}`)) || "";
  const scenario = { reset: RESET, settled: SETTLED, month: MONTH }[name] || BASE;
  const opts = { mobile: args.has("--mobile"), dark: args.has("--dark"), noHistory: args.has("--no-history"), scenario };
  const tag = [opts.mobile ? "mobile" : "desktop", opts.dark ? "dark" : "light", name, opts.noHistory ? "nohistory" : ""]
    .filter(Boolean)
    .join("-");
  report(tag, await shoot({ ...opts, tag }), opts);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
