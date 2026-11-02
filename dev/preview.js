#!/usr/bin/env node
// 本地预览：把 chatgpt.com 的页面和接口全部换成夹具数据，打开面板、打印关键文字并截图到 dev/out/。
//
//   node dev/preview.js                  桌面浅色
//   node dev/preview.js --mobile --dark  iPhone 深色
//   node dev/preview.js --no-history     官网历史读取失败，走近似值路径
//   node dev/preview.js --readme         重新生成 docs/screenshot*.png
//
// 夹具按 2026-10-31 的真实诊断信息和 v1.1 的 README 截图重建，时钟固定在那一刻（UTC+8 时区）。

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
    // 用超 100% 的 5 小时窗口，结束一天多了仍是 accounting_complete: false
    {
      window_minutes: 300,
      starts_at: "2026-10-29T13:05:40Z",
      ends_at: "2026-10-29T18:05:40Z",
      used_basis_points: 10450,
      accounting_complete: false,
      breakdowns: [],
    },
  ],
});

// credits 是查询区间内的相对值，返回前按区间归一化；10/28 在本周期之前，应被脚本过滤掉
const BREAKDOWN = [
  {
    date: "2026-10-28",
    models: [
      { model: "gpt-6-astra", speed: "standard", credits: 6.2 },
      { model: "gpt-6-sol", speed: "standard", credits: 3.1 },
    ],
    product_surface_usage_values: { cli: 6.0, vscode: 3.3 },
  },
  {
    date: "2026-10-29",
    models: [
      { model: "gpt-6-astra", speed: "standard", credits: 30.4 },
      { model: "gpt-6-astra", speed: "fast", credits: 0.7 },
      { model: "gpt-6-sol", speed: "standard", credits: 7.85 },
      { model: "gpt-5.6-terra-2026-06-18", speed: "standard", credits: 7.6 },
      { model: "gpt-5.6-luna", speed: "standard", credits: 2.95 },
      { model: "gpt-6-luna", speed: "standard", credits: 0.07 },
    ],
    product_surface_usage_values: { cli: 29.1, vscode: 18.6, web: 1.87 },
  },
  {
    date: "2026-10-30",
    models: [
      { model: "gpt-6-astra", speed: "standard", credits: 31.2 },
      { model: "gpt-6.1-sol", speed: "standard", credits: 10.05 },
      { model: "gpt-6.1-sol", speed: "fast", credits: 0.14 },
      { model: "gpt-6.1-sol-wm", speed: "standard", credits: 0.37 },
      { model: "gpt-6-sol", speed: "standard", credits: 3.6 },
    ],
    product_surface_usage_values: { cli: 25.4, vscode: 17.9, web: 1.69, work_mobile: 0.37 },
  },
];

const tokens = (input, cached, output) => ({
  uncached_text_input_tokens: input,
  cached_text_input_tokens: cached,
  text_output_tokens: output,
  text_total_tokens: input + cached + output,
});

const TOTALS = [
  { date: "2026-10-28", totals: tokens(402118, 5120334, 98551), models: [{ model: "gpt-6-astra", requests: 212 }] },
  { date: "2026-10-29", totals: tokens(1526880, 19302410, 381720), models: [{ model: "gpt-6-astra", requests: 1043 }] },
  { date: "2026-10-30", totals: tokens(1207330, 18295770, 297940), models: [{ model: "gpt-6-astra", requests: 988 }] },
];

const inRange = (list, url) => {
  const from = url.searchParams.get("start_date") || "0000-00-00";
  const to = url.searchParams.get("end_date") || "9999-99-99";
  return list.filter((r) => r.date >= from && r.date <= to);
};

const normalize = (list) => {
  const total = list.reduce((acc, r) => acc + r.models.reduce((a, m) => a + m.credits, 0), 0) || 1;
  const surfaceTotal = list.reduce((acc, r) => acc + Object.values(r.product_surface_usage_values).reduce((a, v) => a + v, 0), 0) || 1;
  return list.map((r) => ({
    ...r,
    models: r.models.map((m) => ({ ...m, credits: (m.credits / total) * 100 })),
    product_surface_usage_values: Object.fromEntries(
      Object.entries(r.product_surface_usage_values).map(([k, v]) => [k, (v / surfaceTotal) * 100]),
    ),
  }));
};

function backend(url, headers, opts) {
  const p = url.pathname;
  if (headers.authorization !== `Bearer ${TOKEN}`) return [401, { detail: "Unauthorized" }];
  if (p === "/backend-api/wham/usage") return [200, usage()];
  if (p === "/backend-api/wham/accounts/check") {
    return [200, { default_account_id: ACCOUNT_ID, accounts: [{ id: ACCOUNT_ID, plan_type: "pro", account_user_role: "account-owner" }] }];
  }
  if (p === "/backend-api/wham/usage/plan_limit_history") {
    if (opts.noHistory || headers["chatgpt-account-id"] !== ACCOUNT_ID) {
      return [400, { detail: "Unable to scope allowance history to the authenticated account" }];
    }
    return [200, history()];
  }
  if (p === "/backend-api/wham/usage/daily-workspace-user-token-usage-breakdown") return [400, { detail: "No active workspace found" }];
  if (p === "/backend-api/wham/usage/daily-token-usage-breakdown") return [200, { units: "percent", data: normalize(inRange(BREAKDOWN, url)) }];
  if (p === "/backend-api/wham/analytics/daily-workspace-usage-counts") return [200, { data: inRange(TOTALS, url) }];
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

const VIEW_HOOK = "const view = await load();";

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
  }, NOW);

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

  const summary = await page.evaluate(() => {
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
        ? { settled: v.settled, hasSettled: v.hasSettled, live: v.live, quotaSum: v.models.reduce((a, m) => a + m.quota, 0) }
        : null,
    };
  });

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

  if (!opts.files) await save("viewport", (file) => page.screenshot({ path: file }));
  await save("panel", fullPanel);

  let diag = null;
  if (!opts.files) {
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
  }

  await browser.close();
  return { summary, requests, problems, saved, diag };
}

function report(label, { summary: s, requests, problems, saved, diag }, opts) {
  console.log(`\n=== ${label} ===`);
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

  if (s.check) {
    const { settled, hasSettled, live, quotaSum } = s.check;
    const target = hasSettled ? settled : live;
    const ok = Math.abs(quotaSum - target) < 1e-6;
    console.log(
      `核对    模型占周额度合计 ${(quotaSum * 100).toFixed(3)}%，${hasSettled ? "已结算" : "实时"} ${(target * 100).toFixed(3)}%  ${ok ? "一致" : "不一致！"}`,
    );
    if (!ok) process.exitCode = 1;
  }

  if (diag) {
    const leaks = [ACCOUNT_ID, TOKEN, EMAIL].filter((secret) => diag.includes(secret));
    console.log(`诊断    ${diag.length} 字符，${leaks.length ? `泄露了 ${leaks.join("、")}！` : "没有泄露账号 ID、凭证和邮箱"}`);
    if (leaks.length) process.exitCode = 1;
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
      const result = await shoot({ mobile: false, dark, tag: "readme", files: { panel: file } });
      report(dark ? "README 深色" : "README 浅色", result, {});
    }
    return;
  }
  const opts = { mobile: args.has("--mobile"), dark: args.has("--dark"), noHistory: args.has("--no-history") };
  const tag = [opts.mobile ? "mobile" : "desktop", opts.dark ? "dark" : "light", opts.noHistory ? "nohistory" : ""].filter(Boolean).join("-");
  report(tag, await shoot({ ...opts, tag }), opts);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
