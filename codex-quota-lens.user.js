// ==UserScript==
// @name         Codex 额度透镜
// @namespace    codex-quota-lens
// @version      1.2
// @description  在 ChatGPT 用量页查看 Codex 周额度：实时与已结算用量、用量节奏、各模型与来源占比，以及折合 API 价格的估算。
// @author       Wren, Claude
// @match        https://chatgpt.com/*
// @grant        none
// @inject-into  content
// @run-at       document-end
// @noframes
// @homepageURL  https://github.com/2Wren/codex-quota-lens
// @supportURL   https://github.com/2Wren/codex-quota-lens/issues
// @updateURL    https://raw.githubusercontent.com/2Wren/codex-quota-lens/main/codex-quota-lens.user.js
// @downloadURL  https://raw.githubusercontent.com/2Wren/codex-quota-lens/main/codex-quota-lens.user.js
// ==/UserScript==

(function () {
  "use strict";

  if (window.__codexQuotaLens) return;
  window.__codexQuotaLens = true;

  const VERSION = "1.2";
  const TARGET_PATHS = ["/settings/usage", "/codex/cloud/settings/analytics"];
  const DAY_MS = 86400000;
  const WEEK_SECONDS = 604800;
  const EPS = 1e-9;
  const FOLD_KEY = "codex-quota-lens:folds";
  const RANGE_DAYS = 30;

  // 美元 / 1M tokens（OpenAI API 标准价）；fast / ultrafast 为 Codex 订阅额度下相对 Standard 的倍率
  const PRICES = {
    "gpt-6-astra": { input: 10, cached: 1, output: 50, fast: 2.5, ultrafast: 8 },
    "gpt-6.1-sol": { input: 2, cached: 0.1, output: 10, fast: 2.5, ultrafast: 8 },
    "gpt-6-sol": { input: 2, cached: 0.2, output: 10, fast: 2.5 },
    "gpt-6.1-terra": { input: 1, cached: 0.05, output: 5, fast: 2.5 },
    "gpt-6-luna": { input: 0.1, cached: 0.01, output: 0.5, fast: 2.5 },
    "gpt-5.6-sol": { input: 5, cached: 0.5, output: 30, fast: 2.5 },
    "gpt-5.6-terra": { input: 2, cached: 0.2, output: 12, fast: 2.5 },
    "gpt-5.6-luna": { input: 0.2, cached: 0.02, output: 1.2, fast: 2.5 },
    "gpt-5.5": { input: 5, cached: 0.5, output: 30, fast: 2.5 },
    "gpt-5.4": { input: 2.5, cached: 0.25, output: 15, fast: 2 },
    "gpt-5.4-mini": { input: 0.75, cached: 0.075, output: 4.5, fast: 2 },
  };

  const COLORS = ["#3554D1", "#14A098", "#E3A232", "#A35BD0", "#E0607A", "#6B7C93", "#5EA8F2", "#9DB03C"];

  const SOURCE_LABELS = {
    user: "你的对话",
    memory_consolidation: "记忆整理",
    ambient_suggestions: "环境建议",
    thread_title: "生成会话标题",
    subagent: "子代理",
    automation: "自动化",
    system: "系统",
    unknown: "未分类",
  };


  const n = (v) => {
    if (typeof v === "string") v = v.replace(/,/g, "").trim();
    const x = Number(v);
    return Number.isFinite(x) ? x : 0;
  };
  const clamp01 = (v) => Math.min(1, Math.max(0, n(v)));
  const asArray = (v) => (Array.isArray(v) ? v : []);
  const sum = (list, fn) => list.reduce((acc, item) => acc + n(fn(item)), 0);
  const firstPositive = (...values) => {
    for (const v of values) {
      const x = n(v);
      if (x > 0) return x;
    }
    return 0;
  };
  const esc = (v) =>
    String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const trim = (v, d = 2) => n(v).toFixed(d).replace(/\.?0+$/, "");

  const TOKEN_UNITS = [
    { suffix: "B", size: 1e9, digits: 2 },
    { suffix: "M", size: 1e6, digits: 2 },
    { suffix: "K", size: 1e3, digits: 1 },
  ];
  // 同一组数字统一用组内最大值的单位，方便直接比较
  const tokenUnit = (max) => TOKEN_UNITS.find((u) => Math.abs(n(max)) >= u.size) || null;
  const fmtTokensAs = (v, unit) => {
    const x = n(v);
    if (!unit) return String(Math.round(x));
    const text = (x / unit.size).toFixed(unit.digits);
    if (x > 0 && Number(text) === 0) return `<${(1 / 10 ** unit.digits).toFixed(unit.digits)}${unit.suffix}`;
    return `${text}${unit.suffix}`;
  };
  const fmtTokens = (v) => fmtTokensAs(v, tokenUnit(v));
  const fmtUsd = (v) => `$${n(v).toFixed(2)}`;
  const fmtPct = (ratio) => {
    const p = n(ratio) * 100;
    if (p > 0 && p < 0.1) return "<0.1%";
    return `${p.toFixed(1)}%`;
  };

  const pad = (v) => String(v).padStart(2, "0");
  const utcDateKey = (ms) => new Date(ms).toISOString().slice(0, 10);
  const utcDayStart = (key) => {
    const [y, m, d] = String(key || "").slice(0, 10).split("-").map(Number);
    return y && m && d ? Date.UTC(y, m - 1, d) : NaN;
  };
  // 官网的 ends_at 比 wham 的 reset_at 早几百毫秒，按分钟四舍五入，两边才显示成同一时刻
  const toMinute = (ms) => new Date(Math.round(n(ms) / 60000) * 60000);
  const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const fmtTime = (ms) => {
    if (!Number.isFinite(Number(ms))) return "未知";
    const d = toMinute(ms);
    return `${d.getMonth() + 1}/${d.getDate()} ${hhmm(d)}`;
  };
  const fmtClock = (ms) => {
    const d = toMinute(ms);
    return new Date().toDateString() === d.toDateString() ? hhmm(d) : fmtTime(ms);
  };
  const fmtSpan = (start, end) => {
    const sameDay = toMinute(start).toDateString() === toMinute(end).toDateString();
    return `${fmtTime(start)} – ${sameDay ? hhmm(toMinute(end)) : fmtTime(end)}`;
  };
  const fmtDay = (key) => {
    const [, m, d] = String(key).split("-");
    return `${Number(m)}/${Number(d)}`;
  };
  const fmtDuration = (ms) => {
    const minutes = Math.max(0, Math.round(ms / 60000));
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    if (days > 0) return hours > 0 ? `${days} 天 ${hours} 小时` : `${days} 天`;
    if (hours > 0) return `${hours} 小时`;
    return `${minutes} 分钟`;
  };
  const fmtWindow = (minutes) =>
    minutes === 10080 ? "每周" : minutes % 1440 === 0 ? `${minutes / 1440} 天` : minutes % 60 === 0 ? `${minutes / 60} 小时` : `${minutes} 分钟`;


  const modelName = (v) =>
    String(v || "unknown")
      .trim()
      .toLowerCase()
      .replace(/-\d{4}-\d{2}-\d{2}$/, "");
  const speedName = (v) => String(v || "standard").trim().toLowerCase();
  const itemModel = (item = {}) => modelName(item.model || item.model_id || item.model_name || item.name || item.id);
  const speedLabel = (speed) => (speed === "standard" ? "" : speed.charAt(0).toUpperCase() + speed.slice(1));

  const priceFor = (model, speed) => {
    const name = modelName(model);
    // -wm 是 ChatGPT Work 移动端的同款模型，按原模型计价
    const base = PRICES[name] || PRICES[name.replace(/-wm$/, "")];
    if (!base) return null;
    const s = speedName(speed);
    const k = s === "standard" ? 1 : n(base[s]);
    if (!k) return null;
    return { input: base.input * k, cached: base.cached * k, output: base.output * k, multiplier: k };
  };

  const tokenParts = (o = {}) => ({
    input: n(o.uncached_text_input_tokens),
    cached: n(o.cached_text_input_tokens),
    output: n(o.text_output_tokens),
  });
  const tokenTotal = (o = {}) => {
    const t = n(o.text_total_tokens);
    if (t > 0) return t;
    const p = tokenParts(o);
    return p.input + p.cached + p.output;
  };
  const usdFor = (m) => {
    const p = priceFor(m.model, m.speed);
    if (!p) return null;
    return (m.input * p.input + m.cached * p.cached + m.output * p.output) / 1e6;
  };


  let accessToken = null;
  let accountId = null;

  async function fetchToken() {
    try {
      const res = await fetch("/api/auth/session", {
        credentials: "include",
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return null;
      const session = await res.json();
      return session?.accessToken || session?.access_token || null;
    } catch {
      return null;
    }
  }

  async function request(path, token) {
    const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
    if (accountId && path.includes("plan_limit")) headers["ChatGPT-Account-Id"] = accountId;
    const res = await fetch(path, { headers, credentials: "include", cache: "no-store" });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const detail =
        json?.detail || json?.message || (typeof json?.error === "string" ? json.error : json?.error?.message) || text.slice(0, 160);
      const error = new Error(`${res.status}${detail ? ` ${detail}` : ""}`);
      error.status = res.status;
      error.detail = String(detail || "");
      throw error;
    }
    if (json === null) throw new Error("接口返回的不是 JSON");
    return json;
  }

  async function api(path) {
    if (!accessToken) accessToken = await fetchToken();
    if (!accessToken) throw new Error("没有拿到登录凭证，请确认已登录 ChatGPT 后刷新页面");
    try {
      return await request(path, accessToken);
    } catch (error) {
      if (error.status !== 401) throw error;
      accessToken = await fetchToken();
      if (!accessToken) throw error;
      return request(path, accessToken);
    }
  }

  // 官网限额历史要求 ChatGPT-Account-Id，个人账号用 accounts/check 里的 UUID
  async function resolveAccountId() {
    if (accountId) return accountId;
    try {
      const check = await api("/backend-api/wham/accounts/check");
      accountId = check?.default_account_id || asArray(check?.accounts)[0]?.id || null;
    } catch {
      accountId = null;
    }
    if (!accountId) {
      for (const entry of performance.getEntriesByType?.("resource") || []) {
        const match = /[?&]account_id=([0-9a-f-]{36})/i.exec(entry.name || "");
        if (match) {
          accountId = match[1];
          break;
        }
      }
    }
    return accountId;
  }


  const windowSeconds = (w) => firstPositive(w?.limit_window_seconds, w?.window_seconds, w?.duration_seconds);
  const toMs = (v) => {
    if (typeof v === "string") {
      const x = Number(v.trim());
      if (Number.isFinite(x) && x > 0) return x > 1e12 ? x : x * 1000;
      const parsed = Date.parse(v);
      return Number.isFinite(parsed) ? parsed : NaN;
    }
    const x = n(v);
    return x ? (x > 1e12 ? x : x * 1000) : NaN;
  };
  const isWindow = (v) =>
    v && typeof v === "object" && !Array.isArray(v) && ["limit_window_seconds", "window_seconds", "reset_at", "used_percent"].some((k) => k in v);

  const usedRatio = (w) => {
    if (!w) return 0;
    const ratio = firstPositive(w.used_ratio, w.usedRatio);
    if (ratio) return clamp01(ratio);
    const percent = firstPositive(w.used_percent, w.usedPercent);
    if (percent) return clamp01(percent / 100);
    const limit = firstPositive(w.limit);
    const used = firstPositive(w.used);
    const remaining = firstPositive(w.remaining);
    if (limit && used) return clamp01(used / limit);
    if (limit && remaining) return clamp01((limit - remaining) / limit);
    return 0;
  };

  const pickWindows = (usage) => {
    const rl = usage?.rate_limit || usage?.rateLimit || usage?.rate_limits || {};
    const windows = [...asArray(rl.windows), ...Object.values(rl)].filter(isWindow);
    const timed = windows.filter((w) => windowSeconds(w) > 0);
    const weekly =
      [...timed].sort((a, b) => Math.abs(windowSeconds(a) - WEEK_SECONDS) - Math.abs(windowSeconds(b) - WEEK_SECONDS))[0] ||
      rl.secondary_window ||
      rl.primary_window ||
      null;
    const short =
      timed
        .filter((w) => w !== weekly && windowSeconds(w) < windowSeconds(weekly))
        .sort((a, b) => windowSeconds(a) - windowSeconds(b))[0] || null;
    return { weekly, short };
  };

  const cycleRange = (w, now) => {
    const reset = toMs(w?.reset_at || w?.resetAt || w?.resets_at);
    const duration = windowSeconds(w) * 1000;
    if (Number.isFinite(reset) && duration > 0) return { start: reset - duration, end: reset, known: true };
    return { start: now - WEEK_SECONDS * 1000, end: now, known: false };
  };


  const extractList = (payload) => {
    if (Array.isArray(payload)) return payload;
    for (const key of ["data", "items", "results", "daily"]) {
      if (Array.isArray(payload?.[key])) return payload[key];
    }
    return [];
  };

  const modelCredits = (row) => sum(asArray(row?.models), (m) => Math.max(0, n(m?.credits)));
  const surfaceCredits = (row) => sum(Object.values(row?.product_surface_usage_values || {}), (v) => Math.max(0, n(v)));
  const dayWeight = (row) => firstPositive(modelCredits(row), surfaceCredits(row));

  const makeDay = (key, weight, parts, total, models, flags = {}) => {
    let usd = 0;
    let unknownPricing = false;
    models.forEach((m) => {
      m.usd = m.total > EPS ? usdFor(m) : 0;
      if (m.usd === null) unknownPricing = true;
      else usd += m.usd;
    });
    return {
      key,
      ts: utcDayStart(key),
      weight,
      input: parts.input,
      cached: parts.cached,
      output: parts.output,
      total,
      models,
      usd,
      unknownPricing,
      missingTokens: false,
      absCredits: 0,
      shared: false,
      ...flags,
    };
  };

  // Team 接口有每个模型、每种速度的 Token，但 credits 全是 0（2026-11-02 实测），
  // 用量单位从每日明细接口补，那里的 credits 是相对值，和个人账号一样
  const buildTeamDays = (list, breakdownList) => {
    const byKey = (rows) => new Map(rows.map((r) => [String(r?.date || "").slice(0, 10), r]).filter(([key]) => key));
    const teamMap = byKey(list);
    const breakdownMap = byKey(breakdownList);
    const keys = [...new Set([...teamMap.keys(), ...breakdownMap.keys()])].sort();
    return keys
      .map((key) => {
        const row = teamMap.get(key);
        const breakdownRow = breakdownMap.get(key);
        const credits = new Map();
        asArray(breakdownRow?.models).forEach((m) => {
          const k = `${itemModel(m)}|${speedName(m.speed)}`;
          credits.set(k, (credits.get(k) || 0) + Math.max(0, n(m.credits)));
        });
        const models = asArray(row?.models).map((m) => {
          const p = tokenParts(m);
          const k = `${itemModel(m)}|${speedName(m.speed)}`;
          const c = credits.has(k) ? credits.get(k) : Math.max(0, n(m.credits));
          credits.delete(k);
          return { model: itemModel(m), speed: speedName(m.speed), input: p.input, cached: p.cached, output: p.output, total: tokenTotal(m), credits: c, estimated: false, fallback: false };
        });
        credits.forEach((c, k) => {
          const [model, speed] = k.split("|");
          if (c > EPS) models.push({ model, speed, input: 0, cached: 0, output: 0, total: 0, credits: c, estimated: false, fallback: false });
        });
        const total = sum(models, (m) => m.total);
        if (total <= EPS && !(sum(models, (m) => m.credits) > EPS)) return null;
        const parts = { input: sum(models, (m) => m.input), cached: sum(models, (m) => m.cached), output: sum(models, (m) => m.output) };
        return makeDay(key, firstPositive(dayWeight(breakdownRow), dayWeight(row)), parts, total, models, { missingTokens: total <= EPS });
      })
      .filter(Boolean);
  };

  const splitInteger = (total, shares) => {
    const t = Math.max(0, Math.round(n(total)));
    if (!shares.length) return [];
    const raw = shares.map((s) => t * clamp01(s));
    const out = raw.map(Math.floor);
    let rest = t - out.reduce((a, b) => a + b, 0);
    const order = raw.map((v, i) => ({ i, f: v - Math.floor(v) })).sort((a, b) => b.f - a.f || a.i - b.i);
    for (let k = 0; rest > 0; k += 1, rest -= 1) out[order[k % order.length].i] += 1;
    return out;
  };

  // 个人账号每天只有 Token 合计：按「当日额度占比 ÷ 各模型综合费率」反推各模型的 Token
  const tokenShares = (weights, parts) => {
    const total = sum(weights, (w) => w.weight);
    const creditShares = weights.map((w) => w.weight / total);
    if (weights.length === 1) return { shares: [1], fallback: false };
    const all = parts.input + parts.cached + parts.output;
    if (all <= EPS) return { shares: creditShares, fallback: true };
    const mix = { input: parts.input / all, cached: parts.cached / all, output: parts.output / all };
    const rates = weights.map((w) => {
      const p = priceFor(w.model, w.speed);
      if (!p) return null;
      const rate = mix.input * p.input + mix.cached * p.cached + mix.output * p.output;
      return rate > EPS ? rate : null;
    });
    const known = rates.map((r, i) => ({ r, i })).filter((x) => x.r !== null);
    if (!known.length) return { shares: creditShares, fallback: true };
    const knownWeight = sum(known, (x) => weights[x.i].weight);
    const average = known.reduce((acc, x) => acc + (x.r * weights[x.i].weight) / knownWeight, 0);
    const inverse = weights.map((w, i) => w.weight / (rates[i] ?? average));
    const inverseTotal = inverse.reduce((a, b) => a + b, 0);
    return { shares: inverse.map((v) => v / inverseTotal), fallback: known.length !== weights.length };
  };

  const buildPersonalDays = (totalsList, breakdownList) => {
    const byKey = (list) =>
      new Map(list.map((r) => [String(r?.date || "").slice(0, 10), r]).filter(([key]) => key));
    const totalsMap = byKey(totalsList);
    const breakdownMap = byKey(breakdownList);
    const keys = [...new Set([...totalsMap.keys(), ...breakdownMap.keys()])].sort();

    return keys
      .map((key) => {
        const totalsRow = totalsMap.get(key);
        const breakdownRow = breakdownMap.get(key);
        const totals = totalsRow?.totals || totalsRow || {};
        const parts = tokenParts(totals);
        const total = tokenTotal(totals);
        const absCredits = Math.max(0, n(totals.credits));
        const weight = dayWeight(breakdownRow);
        let weights = asArray(breakdownRow?.models)
          .map((m) => ({ model: itemModel(m), speed: speedName(m.speed), weight: n(m.credits) }))
          .filter((w) => w.weight > EPS);
        const hasBreakdown = weights.length > 0;

        if (total <= EPS) {
          if (weight <= EPS) return null;
          const models = weights.map((w) => ({ ...w, input: 0, cached: 0, output: 0, total: 0, credits: w.weight, estimated: false, fallback: false }));
          return makeDay(key, weight, parts, 0, models, { missingTokens: true, absCredits });
        }

        if (!hasBreakdown) weights = [{ model: "unknown", speed: "standard", weight: 1 }];
        const { shares, fallback } = tokenShares(weights, parts);
        const inputs = splitInteger(parts.input, shares);
        const cacheds = splitInteger(parts.cached, shares);
        const outputs = splitInteger(parts.output, shares);
        const estimated = weights.length > 1 || !hasBreakdown;
        const models = weights.map((w, i) => ({
          model: w.model,
          speed: w.speed,
          input: inputs[i],
          cached: cacheds[i],
          output: outputs[i],
          total: inputs[i] + cacheds[i] + outputs[i],
          credits: hasBreakdown ? w.weight : 0,
          estimated,
          fallback: fallback || !hasBreakdown,
        }));
        return makeDay(key, weight, parts, total, models, { absCredits });
      })
      .filter(Boolean);
  };

  async function loadDaily(params) {
    const query = params.toString();
    // 两种账号都要用到这个每日明细，先发出去
    const breakdown = api(`/backend-api/wham/usage/daily-token-usage-breakdown?${query}`);
    breakdown.catch(() => {});
    let team = null;
    try {
      team = await api(`/backend-api/wham/usage/daily-workspace-user-token-usage-breakdown?${query}`);
    } catch (error) {
      if (!(error.status === 400 && /no active workspace/i.test(error.detail || error.message))) throw error;
    }
    if (team) {
      const rows = await breakdown.then(extractList, (error) => {
        console.warn("[Codex 额度透镜] 读取每日明细失败，跨周期的日子只能按时长拆", error);
        return [];
      });
      return { mode: "team", days: buildTeamDays(extractList(team), rows) };
    }
    const totalsParams = new URLSearchParams(params);
    totalsParams.set("workspace_user", "true");
    const [rows, totals] = await Promise.all([breakdown, api(`/backend-api/wham/analytics/daily-workspace-usage-counts?${totalsParams}`)]);
    return { mode: "personal", days: buildPersonalDays(extractList(totals), extractList(rows)) };
  }


  // 官网自己只查 days=7；先试 30 天拿到更多周期，不行再退回 7 天
  async function loadHistory() {
    try {
      if (!(await resolveAccountId())) return null;
    } catch {
      return null;
    }
    for (const days of [RANGE_DAYS, 7]) {
      try {
        return await api(`/backend-api/wham/usage/plan_limit_history?days=${days}`);
      } catch (error) {
        console.warn(`[Codex 额度透镜] 读取官网限额历史失败（days=${days}）`, error);
      }
    }
    return null;
  }

  // used_basis_points：10000 = 100%；data_as_of 为结算截止时刻
  const parseHistory = (payload, weekly, range, now) => {
    if (!payload || !Array.isArray(payload.periods)) return null;
    const periods = payload.periods
      .map((p) => {
        const breakdowns = {};
        asArray(p?.breakdowns).forEach((b) => {
          breakdowns[String(b?.dimension || "")] = asArray(b?.rows)
            .map((r) => ({ key: String(r?.key ?? ""), ratio: n(r?.basis_points) / 10000 }))
            .sort((a, b) => b.ratio - a.ratio);
        });
        return {
          minutes: n(p?.window_minutes),
          start: Date.parse(p?.starts_at),
          end: Date.parse(p?.ends_at),
          used: n(p?.used_basis_points) / 10000,
          complete: Boolean(p?.accounting_complete),
          breakdowns,
        };
      })
      .filter((p) => Number.isFinite(p.start) && Number.isFinite(p.end));

    const tolerance = Math.max(600000, n(payload.boundary_tolerance_seconds) * 1000);
    const minutes = windowSeconds(weekly) / 60 || 10080;
    const reset = toMs(weekly?.reset_at || weekly?.resetAt);
    const same = periods.filter((p) => p.minutes === minutes);
    // 额度提前重置（比如用了重置卡）后，旧周期还留在历史里、ends_at 也不变，
    // 所以只认 ends_at 对得上 reset_at 的那个，不能按「包含当前时刻」兜底
    const current = Number.isFinite(reset)
      ? same.find((p) => Math.abs(p.end - reset) <= tolerance) || null
      : same.find((p) => p.start <= now && now < p.end) || null;

    // 提前结束的窗口有两种样子：结算到重置时刻之后，ends_at 会改成实际结束的时刻（整秒），比窗口长度短；
    // 还没结算到那时，ends_at 仍是原定时间，只能看到在它结束之前已经有同样长度的新窗口开始了
    // （新周期可能还没进历史，所以也拿 wham 的周期比）
    periods.forEach((p) => {
      const starts = periods.filter((q) => q !== p && q.minutes === p.minutes).map((q) => q.start);
      if (p.minutes === minutes && range.known) starts.push(range.start);
      const next = Math.min(...starts.filter((s) => s > p.start + tolerance && s < p.end - tolerance));
      const short = p.minutes > 0 && p.end - p.start < p.minutes * 60000 - tolerance;
      p.cutAt = Number.isFinite(next) ? next : short ? p.end : NaN;
    });

    return { asOf: Date.parse(payload.data_as_of), periods, current, tolerance };
  };


  const clampTo = (v, lo, hi) => Math.min(hi, Math.max(lo, n(v)));
  const dayOf = (ms) => utcDayStart(utcDateKey(ms));

  // 周期列表：当前周期来自 wham，过去的来自官网历史里的每周窗口；被提前重置截断的，按重置时刻结束
  const buildCycles = (history, weekly, range, now) => {
    const minutes = windowSeconds(weekly) / 60 || 10080;
    const asOf = history?.asOf;
    const current = history?.current || null;
    const official = Boolean(current) || (Boolean(history) && Number.isFinite(asOf) && range.start >= asOf);
    const cycles = [
      {
        current: true,
        start: range.start,
        end: range.end,
        until: Math.min(range.end, now),
        known: range.known,
        settled: current ? current.used : official ? 0 : NaN,
        breakdowns: current?.breakdowns || {},
        cut: false,
        live: usedRatio(weekly),
      },
    ];
    (history?.periods || [])
      .filter((p) => p.minutes === minutes && p !== current && p.start < range.start - history.tolerance)
      .forEach((p) => {
        const end = Number.isFinite(p.cutAt) ? p.cutAt : p.end;
        cycles.push({
          current: false,
          start: p.start,
          end,
          until: Math.min(end, now),
          known: true,
          settled: p.used,
          breakdowns: p.breakdowns,
          cut: Number.isFinite(p.cutAt),
          live: p.used,
        });
      });
    return cycles.sort((a, b) => b.start - a.start);
  };

  // 5 小时窗口从第一次使用才开始计时，用量只会落在这些窗口里；重置会让它和每周窗口在同一时刻结束。
  // 官网给了每个窗口用了多少、各模型各多少，按窗口落在一段时间里的时长比例摊进去，就能估出这段时间的用量。
  // 窗口的用量只结算到 data_as_of，所以窗口按那一刻截止
  const usageIn = (history, lo, hi, keep = () => true) => {
    const out = { all: 0, models: new Map() };
    const asOf = Number.isFinite(history?.asOf) ? history.asOf : Infinity;
    (history?.periods || [])
      .filter((p) => p.minutes > 0 && p.minutes < 1440 && keep(p))
      .forEach((p) => {
        const end = Math.min(Number.isFinite(p.cutAt) ? p.cutAt : p.end, asOf);
        const overlap = Math.min(end, hi) - Math.max(p.start, lo);
        if (end <= p.start || overlap <= 0) return;
        const f = overlap / (end - p.start);
        out.all += p.used * f;
        asArray(p.breakdowns?.model).forEach((r) => {
          const k = modelName(r.key);
          out.models.set(k, (out.models.get(k) || 0) + r.ratio * f);
        });
      });
    return out;
  };

  // 一天里几个周期各占多少。已结算的日子按 5 小时窗口的用量分，能细到每个模型（by: "5h"）；
  // 没结算或没有窗口记录就按时长分（by: "time"）。
  // 不属于任何已知周期的用量记作 lost：第一个已知周期开始之前的（更早的周期），
  // 和最后一个周期结束之后才开始的窗口（历史里缺了的周期，Team 账号实测缺过 10/15–10/20 一整周）
  const dayShares = (owners, ts, history, now, settled) => {
    const hi = Math.min(ts + DAY_MS, now);
    const spans = owners.map((c) => [Math.max(c.start, ts), Math.min(c.until, hi)]);
    if (settled) {
      // 周期自然结束后，5 小时窗口还会继续走，但下个周期开始之前不会有用量，所以这段空档算前一个周期的。
      // 在周期结束那一刻或之后才开始的窗口不可能有它的用量（Team 实测有窗口正好从重置那一刻开始）
      const lead = spans[0][0];
      const end = owners[owners.length - 1].until;
      const parts = spans.map(([s], k) =>
        usageIn(history, s, k + 1 < spans.length ? spans[k + 1][0] : hi, (p) => p.start < owners[k].until),
      );
      const head = usageIn(history, ts, lead);
      const tail = usageIn(history, end, hi, (p) => p.start >= end);
      const lost = (m) => (m ? (head.models.get(m) || 0) + (tail.models.get(m) || 0) : head.all + tail.all);
      const total = sum(parts, (u) => u.all) + lost();
      if (total > EPS) {
        const model = (m) => {
          const v = parts.map((u) => u.models.get(m) || 0);
          const t = sum(v, (x) => x) + lost(m);
          return t > EPS ? { shares: v.map((x) => x / t), lost: lost(m) / t } : null;
        };
        return { by: "5h", shares: parts.map((u) => u.all / total), lost: lost() / total, model };
      }
    }
    const plain = spans.map(([s, e]) => Math.max(0, e - s));
    const all = sum(plain, (v) => v);
    return { by: "time", shares: plain.map((v) => (all > 0 ? v / all : 1 / owners.length)), lost: 0, model: () => null };
  };

  // 拆分和换算都用每日明细里的相对 credits：同一次查询里它和绝对 credits 成正比，
  // 而且 Team 账号的 counts 接口 credits 全是 0，只有相对值可用
  const unitsOf = (d) => sum(d.models, (m) => m.credits);

  // 绝对 credits ÷ 相对值，用来把结果换回 credits；个人账号才有
  const creditScale = (days) => {
    const both = days.filter((d) => d.absCredits > EPS && unitsOf(d) > EPS);
    return both.length ? sum(both, (d) => d.absCredits) / sum(both, unitsOf) : NaN;
  };

  // 每 100% 周额度合多少（相对值）：从明细能覆盖到的最早一个周期起，已结算整天的用量 ÷ 这些周期已结算用量之和。
  // 只算属于这些周期的那部分：最早那天里更早周期的、历史里缺了的周期的用量都按 dayShares 扣掉
  const estimateQuota = (cycles, days, history, firstTs, now) => {
    const asOf = history?.asOf;
    if (!Number.isFinite(asOf)) return NaN;
    const set = cycles.filter((c) => c.start >= firstTs);
    if (!set.length || set.some((c) => !Number.isFinite(c.settled))) return NaN;
    const from = dayOf(Math.min(...set.map((c) => c.start)));
    const settledDays = days.filter((d) => d.ts >= from && d.ts + DAY_MS <= asOf);
    if (settledDays.some((d) => d.total > EPS && !(unitsOf(d) > EPS))) return NaN;
    let units = 0;
    settledDays.forEach((d) => {
      const owners = cycles.filter((c) => c.start < d.ts + DAY_MS && c.until > d.ts).sort((x, y) => x.start - y.start);
      if (!owners.length) return;
      const { shares, lost } = dayShares(owners, d.ts, history, now, true);
      const outside = lost + sum(owners, (c) => (set.includes(c) ? 0 : shares[owners.indexOf(c)]));
      units += unitsOf(d) * Math.max(0, 1 - outside);
    });
    const used = sum(set, (c) => c.settled);
    return used > 0.005 && units > EPS ? units / used : NaN;
  };

  // 把一天按比例拆成几份；最后一份拿余数，各份加起来正好等于原来那天
  const splitDay = (d, fractions, method) => {
    const left = d.models.map((m) => ({ input: m.input, cached: m.cached, output: m.output, credits: m.credits }));
    const relTotal = sum(d.models, (m) => m.credits);
    return fractions.map((fracOf, k) => {
      const last = k === fractions.length - 1;
      const models = d.models.map((m, j) => {
        const f = clamp01(fracOf(m.model));
        const take = (key) => (last ? left[j][key] : Math.min(left[j][key], Math.round(m[key] * f)));
        const piece = { ...m, input: take("input"), cached: take("cached"), output: take("output") };
        piece.credits = last ? left[j].credits : Math.min(left[j].credits, m.credits * f);
        ["input", "cached", "output", "credits"].forEach((key) => {
          left[j][key] -= piece[key];
        });
        piece.total = piece.input + piece.cached + piece.output;
        return piece;
      });
      const credits = sum(models, (m) => m.credits);
      const share = relTotal > EPS ? credits / relTotal : clamp01(fracOf(""));
      const parts = { input: sum(models, (m) => m.input), cached: sum(models, (m) => m.cached), output: sum(models, (m) => m.output) };
      return makeDay(d.key, relTotal > EPS ? credits : d.weight * share, parts, sum(models, (m) => m.total), models, {
        missingTokens: d.missingTokens,
        absCredits: d.absCredits * share,
        shared: true,
        splitBy: method,
      });
    });
  };

  // 每日数据按 UTC 日分桶，一天可能跨两个周期（提前重置当天，或上个周期结束、本周期开始在同一天）。拆法：
  // 已结算的日子按 5 小时窗口的官方用量拆，细到每个模型；
  // 还没结算、后一个是当前周期，就让它拿「实时用量 × 换算比例 − 它之后几天」，所以从最近的一天往回分；
  // 都不行就按时长。credits 和额度的比例每天都在变（Plus 实测 11/1 比前几天低 17%），能不用换算比例就不用
  const assignDays = (cycles, days, history, quota, now) => {
    const asOf = history?.asOf;
    const order = [...cycles].sort((a, b) => a.start - b.start);
    order.forEach((c) => {
      c.days = [];
      c.later = 0;
    });
    days
      .filter((d) => Number.isFinite(d.ts))
      .sort((a, b) => b.ts - a.ts)
      .forEach((d) => {
        const owners = order.filter((c) => c.start < d.ts + DAY_MS && c.until > d.ts);
        if (!owners.length) return;
        const settled = Number.isFinite(asOf) && d.ts + DAY_MS <= asOf;
        const shares = dayShares(owners, d.ts, history, now, settled);
        const keep = (piece, k) => {
          if (piece.shared && !(unitsOf(piece) > EPS) && !(piece.total > 0)) return;
          owners[k].days.push(piece);
          owners[k].later += unitsOf(piece);
        };
        if (owners.length === 1 && shares.lost < 0.005) {
          keep(d, 0);
          return;
        }
        const b = owners[owners.length - 1];
        const total = unitsOf(d);
        let method = shares.by;
        let fractions;
        if (!settled && owners.length === 2 && b.current && Number.isFinite(quota) && total > EPS) {
          const s = clampTo(b.live * quota - b.later, 0, total) / total;
          method = "credits";
          fractions = [() => 1 - s, () => s];
        } else {
          const of = (model) => shares.model(model) || shares;
          fractions = owners.map((c, k) => (model) => of(model).shares[k]);
          // 多出来的那份属于历史里没有的更早周期，拆出来丢掉
          if (shares.lost > 0) fractions.push((model) => of(model).lost);
        }
        splitDay(d, fractions, method).forEach((piece, k) => {
          if (k < owners.length) keep(piece, k);
        });
      });
    order.forEach((c) => c.days.sort((x, y) => x.ts - y.ts));
  };

  const aggregateModels = (days) => {
    const map = new Map();
    days.forEach((d) =>
      d.models.forEach((m) => {
        if (m.total <= EPS && m.credits <= EPS) return;
        const key = `${m.model}|${m.speed}`;
        const row =
          map.get(key) ||
          { model: m.model, speed: m.speed, input: 0, cached: 0, output: 0, total: 0, credits: 0, usd: 0, unknownPricing: false, estimated: false, fallback: false };
        row.input += m.input;
        row.cached += m.cached;
        row.output += m.output;
        row.total += m.total;
        row.credits += m.credits;
        row.estimated ||= m.estimated;
        row.fallback ||= m.fallback;
        if (m.total > EPS) {
          if (m.usd === null) row.unknownPricing = true;
          else row.usd += m.usd;
        }
        map.set(key, row);
      }),
    );
    return [...map.values()];
  };

  const buildView = (data, index) => {
    const { mode, usage, weekly, short, history, now, cycles, quota, minutes } = data;
    const c = cycles[index];
    const asOf = history?.asOf;
    const days = [...c.days].sort((a, b) => a.ts - b.ts);
    const range = { start: c.start, end: c.end, known: c.known };
    const settled = c.settled;
    const hasSettled = Number.isFinite(settled);
    // 过去的周期没有实时值；结束时间晚于结算截止的，用每日明细里还没结算的 credits 估出剩下那段
    const unsettledUnits = !c.current && Number.isFinite(asOf) ? sum(days.filter((d) => d.ts + DAY_MS > asOf), unitsOf) : 0;
    const estimated = !c.current && hasSettled && quota > EPS ? unsettledUnits / quota : 0;
    const live = c.current ? usedRatio(weekly) : Math.max(0, n(settled)) + estimated;
    const livePercent = c.current ? firstPositive(weekly?.used_percent, weekly?.usedPercent) || live * 100 : live * 100;
    const pending = c.current ? (hasSettled ? Math.max(0, live - settled) : 0) : estimated;

    const models = aggregateModels(days);
    const totalCredits = sum(models, (m) => m.credits);
    models.forEach((m) => {
      m.share = totalCredits > EPS ? m.credits / totalCredits : 0;
      m.quota = NaN;
      m.approx = true;
    });

    const officialModels = asArray(c.breakdowns?.model);
    if (officialModels.length) {
      const officialMap = new Map(officialModels.map((r) => [modelName(r.key), r.ratio]));
      const creditsByModel = new Map();
      const countByModel = new Map();
      models.forEach((m) => {
        creditsByModel.set(m.model, (creditsByModel.get(m.model) || 0) + m.credits);
        countByModel.set(m.model, (countByModel.get(m.model) || 0) + 1);
      });
      models.forEach((m) => {
        // 官网这个周期里没有它：用量还没结算。不分摊额度，合计才等于已结算
        if (!officialMap.has(m.model)) {
          m.quota = 0;
          m.unsettled = true;
          m.approx = false;
          return;
        }
        const credits = creditsByModel.get(m.model) || 0;
        m.quota = officialMap.get(m.model) * (credits > EPS ? m.credits / credits : 1 / countByModel.get(m.model));
        m.approx = false;
      });
      officialMap.forEach((ratio, name) => {
        // 官网会列出用量为 0 的模型
        if (countByModel.has(name) || !(ratio > 0)) return;
        models.push({
          model: name, speed: "standard", input: 0, cached: 0, output: 0, total: 0, credits: 0, usd: 0,
          unknownPricing: false, estimated: false, fallback: false, share: 0, quota: ratio, approx: false,
        });
      });
    }
    // 新周期还没结算过时已结算是 0，先按实时比例近似
    const quotaApprox = !officialModels.length;
    const base = hasSettled && settled > EPS ? settled : live;
    models.forEach((m) => {
      if (!Number.isFinite(m.quota)) m.quota = m.share * base;
    });
    models.sort((a, b) => b.quota - a.quota || b.total - a.total);

    const quotaByName = new Map();
    models.forEach((m) => quotaByName.set(m.model, (quotaByName.get(m.model) || 0) + m.quota));
    const colorOf = new Map([...quotaByName.entries()].sort((a, b) => b[1] - a[1]).map(([name], i) => [name, COLORS[i % COLORS.length]]));
    models.forEach((m) => {
      m.color = colorOf.get(m.model);
    });

    const settledDays = days.filter((d) => !Number.isFinite(asOf) || d.ts < asOf);
    const settledWeight = sum(settledDays, (d) => d.weight);
    const covered = settledDays.filter((d) => !d.missingTokens);
    const coveredShare = settledWeight > EPS ? sum(covered, (d) => d.weight) / settledWeight : 1;
    const coveredUsd = sum(covered, (d) => d.usd);
    const projectionBase = hasSettled ? settled * coveredShare : live;
    const projectedUsd = !c.partial && projectionBase > EPS && coveredUsd > 0 ? coveredUsd / projectionBase : NaN;

    let elapsed = NaN;
    let exhaustAt = NaN;
    let endRatio = NaN;
    if (c.current) {
      const span = range.end - range.start;
      elapsed = range.known && span > 0 ? clamp01((now - range.start) / span) : NaN;
      if (Number.isFinite(elapsed) && elapsed > 0.02 && live > 0.01) {
        const at = range.start + (now - range.start) / live;
        if (at < range.end) exhaustAt = at;
        endRatio = live / elapsed;
      }
    }

    // 窗口要等第一次使用才开始计时，没开始时 reset_after_seconds 等于整个窗口长度
    const shortWindow =
      c.current && short
        ? {
            used: usedRatio(short),
            percent: firstPositive(short.used_percent) || usedRatio(short) * 100,
            reset: toMs(short.reset_at),
            minutes: windowSeconds(short) / 60,
            idle: usedRatio(short) <= 0 && Math.abs(n(short.reset_after_seconds) - windowSeconds(short)) < 60,
          }
        : null;

    const extraLimits = !c.current
      ? []
      : asArray(usage?.additional_rate_limits).flatMap((entry) =>
          [entry?.rate_limit?.primary_window, entry?.rate_limit?.secondary_window].filter(isWindow).map((w) => ({
            name: entry?.limit_name || entry?.metered_feature || "其他限额",
            minutes: windowSeconds(w) / 60,
            used: usedRatio(w),
            reset: toMs(w.reset_at),
          })),
        );

    const tolerance = history?.tolerance || 0;
    const periods = (history?.periods || []).filter((p) => p.minutes !== minutes && p.start >= c.start - tolerance && p.start < c.until);
    const unknownModels = [...new Set(models.filter((m) => m.unknownPricing).map((m) => m.model))];

    return {
      mode, range, now, live, livePercent, settled, hasSettled, pending, asOf,
      current: c.current, cut: c.cut, partial: c.partial, estimated: estimated > 0.0005,
      nav: { index, count: cycles.length },
      models, colorOf, days, quotaApprox,
      quotaTotal: quotaApprox ? base : settled,
      tokens: sum(days, (d) => d.total),
      usd: sum(days, (d) => d.usd),
      projectedUsd,
      elapsed, exhaustAt, endRatio,
      shortWindow, extraLimits, periods,
      sources: asArray(c.breakdowns?.thread_source).filter((r) => r.ratio > 0.00005),
      missingDays: days.filter((d) => d.missingTokens).length,
      timeSplitDays: days.filter((d) => d.splitBy === "time"),
      unknownModels,
    };
  };

  async function load() {
    const now = Date.now();
    accessToken = await fetchToken();
    if (!accessToken) throw new Error("没有拿到登录凭证，请确认已登录 ChatGPT 后刷新页面");
    const usage = await api("/backend-api/wham/usage");
    const { weekly, short } = pickWindows(usage);
    const range = cycleRange(weekly, now);
    // 和官网一样一次查 30 天，切换周期时不用再请求
    const firstTs = dayOf(now - (RANGE_DAYS - 1) * DAY_MS);
    const params = new URLSearchParams({ start_date: utcDateKey(firstTs), end_date: utcDateKey(now), group_by: "day" });
    const [daily, historyPayload] = await Promise.all([loadDaily(params), loadHistory()]);
    const history = parseHistory(historyPayload, weekly, range, now);
    const cycles = buildCycles(history, weekly, range, now);
    const quota = estimateQuota(cycles, daily.days, history, firstTs, now);
    assignDays(cycles, daily.days, history, quota, now);
    cycles.forEach((c) => {
      c.partial = c.start < firstTs;
    });
    return { mode: daily.mode, usage, weekly, short, history, now, cycles, quota, days: daily.days, minutes: windowSeconds(weekly) / 60 || 10080 };
  }


  const readFolds = () => {
    try {
      return JSON.parse(localStorage.getItem(FOLD_KEY) || "{}") || {};
    } catch {
      return {};
    }
  };
  const writeFold = (id, open) => {
    try {
      localStorage.setItem(FOLD_KEY, JSON.stringify({ ...readFolds(), [id]: open }));
    } catch {
      return;
    }
  };

  const mini = (ratio, color) =>
    `<span class="ql-mini"><i style="width:${(clamp01(ratio) * 100).toFixed(2)}%${color ? `;background:${color}` : ""}"></i></span>`;

  const cycleLabel = (v) =>
    `${v.current ? "本周期 " : ""}${esc(fmtTime(v.range.start))} – ${esc(fmtTime(v.range.end))}${v.cut ? `<span class="ql-tag">提前重置</span>` : ""}`;

  const renderNav = (v) => {
    const { index, count } = v.nav;
    if (count < 2) return `<span>${cycleLabel(v)}</span>`;
    return `<span class="ql-nav">
        <button type="button" class="ql-nav-btn" data-act="older" aria-label="上一个周期"${index >= count - 1 ? " disabled" : ""}>‹</button>
        <span>${cycleLabel(v)}</span>
        <button type="button" class="ql-nav-btn" data-act="newer" aria-label="下一个周期"${index <= 0 ? " disabled" : ""}>›</button>
      </span>`;
  };

  const renderHeader = (view) => `
    <header class="ql-head">
      <h2>Codex 额度</h2>
      <div class="ql-actions">
        <button type="button" class="ql-btn" data-act="refresh">刷新</button>
        <button type="button" class="ql-btn ql-icon" data-act="close" aria-label="关闭">×</button>
      </div>
      <p>${
        view
          ? `<span class="ql-mode">${view.mode === "team" ? "Team 工作区" : "个人账号"}</span>${renderNav(view)}`
          : "<span>正在读取</span>"
      }</p>
    </header>`;

  const paceSentence = (v) => {
    if (!v.current) {
      const ended = v.cut ? `用了 ${esc(fmtDuration(v.range.end - v.range.start))}，${esc(fmtTime(v.range.end))} 提前重置。` : `${esc(fmtTime(v.range.end))} 结束。`;
      const lag = !(Number.isFinite(v.asOf) && v.asOf < v.range.end)
        ? ""
        : v.estimated
          ? `官网只结算到 ${esc(fmtTime(v.asOf))}，之后的 ${fmtPct(v.pending)} 是按每日明细估的。`
          : `官网只结算到 ${esc(fmtTime(v.asOf))}，之后的用量还没算进来。`;
      return ended + lag;
    }
    if (v.live >= 1) return `本周额度已用完，${esc(fmtTime(v.range.end))} 重置。`;
    if (Number.isFinite(v.exhaustAt)) {
      return `照现在的速度，额度会在 ${esc(fmtTime(v.exhaustAt))} 左右用完，比重置早 ${esc(fmtDuration(v.range.end - v.exhaustAt))}。`;
    }
    if (Number.isFinite(v.endRatio)) {
      return `照现在的速度，到 ${esc(fmtTime(v.range.end))} 重置时大约用掉 ${fmtPct(Math.min(v.endRatio, 1))}。`;
    }
    return v.range.known ? `${esc(fmtTime(v.range.end))} 重置。` : "";
  };

  const renderHero = (v) => {
    let segments = "";
    if (v.hasSettled) {
      const groups = [...v.colorOf.keys()]
        .map((name) => ({ name, color: v.colorOf.get(name), quota: sum(v.models.filter((m) => m.model === name), (m) => m.quota) }))
        .filter((g) => g.quota > EPS && v.settled > EPS);
      const major = groups.filter((g) => g.quota >= 0.004);
      const minor = sum(groups.filter((g) => g.quota < 0.004), (g) => g.quota);
      const scale = sum(groups, (g) => g.quota) > EPS ? v.settled / sum(groups, (g) => g.quota) : 1;
      segments = major
        .map((g) => `<span class="ql-seg" title="${esc(g.name)} ${fmtPct(g.quota)}" style="width:${(g.quota * scale * 100).toFixed(3)}%;background:${g.color}"></span>`)
        .join("");
      if (minor > EPS) segments += `<span class="ql-seg ql-seg-minor" title="其他 ${fmtPct(minor)}" style="width:${(minor * scale * 100).toFixed(3)}%"></span>`;
      if (!groups.length && v.settled > EPS) segments = `<span class="ql-seg" style="width:${(v.settled * 100).toFixed(3)}%;background:var(--accent)"></span>`;
      if (v.pending > 0.0005) segments += `<span class="ql-seg ql-seg-pending" title="尚未结算 ${fmtPct(v.pending)}" style="width:${(v.pending * 100).toFixed(3)}%"></span>`;
    } else {
      segments = `<span class="ql-seg" style="width:${(v.live * 100).toFixed(3)}%;background:var(--accent)"></span>`;
    }

    const marker = Number.isFinite(v.elapsed)
      ? `<span class="ql-marker" style="left:${(v.elapsed * 100).toFixed(2)}%"></span>
         <span class="ql-marker-label${v.elapsed < 0.12 ? " is-start" : v.elapsed > 0.88 ? " is-end" : ""}" style="left:${(v.elapsed * 100).toFixed(2)}%">时间过去 ${fmtPct(v.elapsed)}</span>`
      : "";

    const swatchSettled = `linear-gradient(90deg, ${[...v.colorOf.values()].slice(0, 3).join(", ") || "var(--accent), var(--accent)"})`;
    const keys = v.estimated
      ? `
        <div class="ql-key"><span class="ql-swatch" style="background:${swatchSettled}"></span>已结算 <b>${fmtPct(v.settled)}</b><span class="ql-key-note">截至 ${esc(fmtTime(v.asOf))}</span></div>
        <div class="ql-key"><span class="ql-swatch ql-swatch-pending"></span>尚未结算 <b>≈${fmtPct(v.pending)}</b><span class="ql-key-note">估算</span></div>
        <div class="ql-key"><span class="ql-swatch ql-swatch-empty"></span>没用到 <b>≈${fmtPct(Math.max(0, 1 - v.live))}</b></div>`
      : !v.current
      ? `
        <div class="ql-key"><span class="ql-swatch" style="background:${swatchSettled}"></span>已用 <b>${fmtPct(v.settled)}</b>${
          Number.isFinite(v.asOf) && v.asOf < v.range.end ? `<span class="ql-key-note">截至 ${esc(fmtTime(v.asOf))}</span>` : ""
        }</div>
        <div class="ql-key"><span class="ql-swatch ql-swatch-empty"></span>没用到 <b>${fmtPct(Math.max(0, 1 - v.settled))}</b></div>`
      : v.hasSettled
      ? `
        <div class="ql-key"><span class="ql-swatch" style="background:${swatchSettled}"></span>已结算 <b>${fmtPct(v.settled)}</b>${
          Number.isFinite(v.asOf) ? `<span class="ql-key-note">截至 ${esc(fmtTime(v.asOf))}</span>` : ""
        }</div>
        <div class="ql-key"><span class="ql-swatch ql-swatch-pending"></span>尚未结算 <b>${fmtPct(v.pending)}</b></div>
        <div class="ql-key"><span class="ql-swatch ql-swatch-empty"></span>剩余 <b>${fmtPct(Math.max(0, 1 - v.live))}</b></div>`
      : `
        <div class="ql-key"><span class="ql-swatch" style="background:var(--accent)"></span>已用 <b>${fmtPct(v.live)}</b><span class="ql-key-note">实时</span></div>
        <div class="ql-key"><span class="ql-swatch ql-swatch-empty"></span>剩余 <b>${fmtPct(Math.max(0, 1 - v.live))}</b></div>`;

    const short = v.shortWindow
      ? `<div class="ql-short">
           <span>${esc(fmtWindow(v.shortWindow.minutes))}窗口</span>
           ${mini(v.shortWindow.used, "var(--ink)")}
           <b>${esc(trim(v.shortWindow.percent, 1))}%</b>
           ${v.shortWindow.idle ? "<span>还没开始计时</span>" : Number.isFinite(v.shortWindow.reset) ? `<span>${esc(fmtClock(v.shortWindow.reset))} 重置</span>` : ""}
         </div>`
      : "";

    return `
      <section class="ql-hero">
        <div class="ql-top">
          <div class="ql-num">${esc(trim(v.livePercent, 1))}<small>%</small></div>
          <div class="ql-top-text">
            <p class="ql-lead">${v.current ? "本周额度已用" : v.estimated ? "这个周期大约用了" : "这个周期用了"}</p>
            <p class="ql-pace">${paceSentence(v)}</p>
          </div>
        </div>
        <div class="ql-bar${marker ? " ql-has-marker" : ""}" role="img" aria-label="${v.current ? "本周额度已用" : "这个周期用了"} ${fmtPct(v.live)}${v.hasSettled ? `，其中已结算 ${fmtPct(v.settled)}` : ""}">
          <div class="ql-fill">${segments}</div>
          ${marker}
        </div>
        <div class="ql-legend">${keys}</div>
        ${short}
      </section>`;
  };

  const renderFigures = (v) => {
    const star = v.unknownModels.length ? "*" : "";
    const none = v.partial && !(v.tokens > 0);
    return `
      <section class="ql-figures">
        <div class="ql-figure"><b>${none ? "—" : `${fmtUsd(v.usd)}${star}`}</b><span>折合 API 价格</span></div>
        <div class="ql-figure"><b>${Number.isFinite(v.projectedUsd) ? `${fmtUsd(v.projectedUsd)}${star}` : "—"}</b><span>${
          Number.isFinite(v.projectedUsd) ? (v.current ? "整周推算" : "整周额度约合") : "暂无推算"
        }</span></div>
        <div class="ql-figure"><b>${none ? "—" : fmtTokens(v.tokens)}</b><span>已统计 Tokens</span></div>
      </section>`;
  };

  const renderNotices = (v) => {
    const notes = [];
    if (!v.hasSettled) {
      notes.push("没读到官网的已结算数据，各模型占比按实时比例近似（标 ≈），整周推算会偏低。可以在页面底部导出诊断信息排查。");
    }
    if (v.current && v.hasSettled && v.settled <= EPS && v.models.length) {
      notes.push("本周期官网还没结算过，各模型占比先按实时比例近似（标 ≈）。");
    }
    if (v.timeSplitDays.length) {
      notes.push(`${v.timeSplitDays.map((d) => esc(fmtDay(d.key))).join("、")} 跨了两个周期，只能按使用时长粗略拆分，这几天的 Token 和金额是估算。`);
    }
    if (v.partial) {
      notes.push(
        v.tokens > 0
          ? "这个周期开头有几天超出了能查到的 30 天明细，Token 和金额不全。"
          : "这个周期的用量都在能查到的 30 天明细之前，只有官网的额度数据，没有 Token 和金额。",
      );
    }
    if (v.missingDays) notes.push(`有 ${v.missingDays} 天只有额度数据、没有 Token 明细，这几天不计入金额。`);
    if (v.unknownModels.length) notes.push(`${v.unknownModels.map(esc).join("、")} 没有公开 API 价格，带 * 的金额只算了其余模型。`);
    return notes.map((t) => `<p class="ql-notice">${t}</p>`).join("");
  };

  const modelDetail = (m) => {
    const price = priceFor(m.model, m.speed);
    // 价格按每百万计，明细统一用 M；小数位按最小的那一项取够三位有效数字
    const nonzero = [m.input, m.cached, m.output].filter((x) => x > 0);
    const smallest = nonzero.length ? Math.min(...nonzero) / 1e6 : 1;
    const unit = { suffix: "M", size: 1e6, digits: Math.min(6, Math.max(3, Math.ceil(-Math.log10(smallest)) + 2)) };
    const parts = `
      <div class="ql-parts">
        <div><span>未缓存输入</span><b>${fmtTokensAs(m.input, unit)}</b></div>
        <div><span>缓存输入</span><b>${fmtTokensAs(m.cached, unit)}</b></div>
        <div><span>输出</span><b>${fmtTokensAs(m.output, unit)}</b></div>
      </div>`;
    if (m.total <= EPS) return `<p>这个模型的用量发生在没有 Token 明细的日子，算不出金额。</p>`;
    if (!price) return `${parts}<p>这个模型没有公开 API 价格，不计入金额。</p>`;
    const line = [
      [m.input, price.input],
      [m.cached, price.cached],
      [m.output, price.output],
    ]
      .map(([t, p]) => `${fmtTokensAs(t, unit)} × $${trim(p, 3)}/M`)
      .join(" + ");
    const notes = [];
    if (price.multiplier !== 1) notes.push(`${speedLabel(m.speed)} 按 Standard 的 ${trim(price.multiplier, 2)} 倍计价。`);
    if (m.estimated) notes.push(m.fallback ? "Token 按已知模型的平均费率从当日合计中估算。" : "Token 按各模型费率从当日合计中反推，是估算值。");
    return `${parts}<p class="ql-calc">${line} = ${fmtUsd(m.usd)}</p>${notes.length ? `<p>${notes.join("")}</p>` : ""}`;
  };

  const renderModels = (v) => {
    if (!v.models.length) {
      return `<section class="ql-block"><h3>模型</h3><p class="ql-empty">本周期还没有已统计的用量，通常次日就会出现。</p></section>`;
    }
    const approx = (m) => (m.approx ? "≈" : "");
    const unit = tokenUnit(v.tokens);
    const rows = v.models
      .map(
        (m, i) => `
        <button type="button" class="ql-row" data-row="${i}" aria-expanded="false">
          <span class="ql-dot" style="background:${m.color}"></span>
          <span class="ql-name">${esc(m.model)}${speedLabel(m.speed) ? `<span class="ql-tag">${esc(speedLabel(m.speed))}</span>` : ""}</span>
          <span class="ql-cell c-quota">${m.unsettled ? `<span title="这部分用量还没进官网结算">—</span>` : `${approx(m)}${fmtPct(m.quota)}`}</span>
          <span class="ql-cell c-tok${m.total > EPS ? "" : " is-none"}">${m.total > EPS ? fmtTokensAs(m.total, unit) : "—"}</span>
          <span class="ql-cell c-usd">${m.total > EPS && !m.unknownPricing ? fmtUsd(m.usd) : "—"}</span>
        </button>
        <div class="ql-detail" data-detail="${i}" hidden>${modelDetail(m)}</div>`,
      )
      .join("");
    return `
      <section class="ql-block">
        <div class="ql-block-head">
          <h3>模型</h3>
          <p class="ql-hint">${v.quotaApprox ? "占周额度按实时比例近似" : "占周额度为官网数据"}${v.tokens > 0 ? (v.mode === "team" ? "，金额为估算，点一行看计算" : "，Token 与金额为估算，点一行看计算") : ""}</p>
        </div>
        <div class="ql-cols"><span></span><span>模型</span><span>占周额度</span><span>Tokens</span><span>折合金额</span></div>
        <div class="ql-rows">${rows}</div>
        <div class="ql-row ql-row-total">
          <span></span>
          <span class="ql-name">合计</span>
          <span class="ql-cell c-quota">${v.quotaApprox ? "≈" : ""}${fmtPct(v.quotaTotal)}</span>
          <span class="ql-cell c-tok${v.tokens > 0 ? "" : " is-none"}">${v.tokens > 0 ? fmtTokensAs(v.tokens, unit) : "—"}</span>
          <span class="ql-cell c-usd">${v.tokens > 0 ? fmtUsd(v.usd) : "—"}</span>
        </div>
      </section>`;
  };

  const fold = (id, title, meta, body, folds) => `
    <details class="ql-fold" data-fold="${id}"${folds[id] ? " open" : ""}>
      <summary><span>${title}</span>${meta ? `<span class="ql-sum-meta">${meta}</span>` : ""}<span class="ql-chev" aria-hidden="true"></span></summary>
      <div class="ql-fold-body">${body}</div>
    </details>`;

  const renderWindows = (v, folds) => {
    const rows = [...v.periods]
      .sort((a, b) => b.minutes - a.minutes || b.start - a.start)
      .map(
        (p) => `
        <div class="ql-list-row">
          <span class="ql-label">${esc(fmtWindow(p.minutes))}<small>${esc(fmtSpan(p.start, Number.isFinite(p.cutAt) ? p.cutAt : p.end))}</small></span>
          ${mini(p.used, "var(--ink)")}
          <span class="ql-val">${fmtPct(p.used)}</span>
          <span class="ql-extra">${
            Number.isFinite(p.cutAt)
              ? `<span title="额度提前重置，这个窗口没到原定时间就结束了">已重置</span>`
              : p.start <= v.now && v.now < p.end
                ? "进行中"
                : p.complete
                  ? "已结算"
                  : `<span title="窗口已结束，但官方数据仍标记为未完成核算，数值一般不再变化">未核完</span>`
          }</span>
        </div>`,
      );
    v.extraLimits.forEach((l) =>
      rows.push(`
        <div class="ql-list-row">
          <span class="ql-label">${esc(l.name)}<small>${esc(fmtWindow(l.minutes))}，独立计算</small></span>
          ${mini(l.used, "var(--ink)")}
          <span class="ql-val">${fmtPct(l.used)}</span>
          <span class="ql-extra">${Number.isFinite(l.reset) ? `${esc(fmtClock(l.reset))} 重置` : ""}</span>
        </div>`),
    );
    if (!rows.length) return "";
    const hint = v.periods.length
      ? `来自官网「套餐用量历史」${Number.isFinite(v.asOf) ? `，结算截至 ${esc(fmtTime(v.asOf))}` : ""}。进行中的窗口还会继续增长；「未核完」是官方对个别已结束窗口的标记，多见于用超 100% 的窗口${
          v.periods.some((p) => Number.isFinite(p.cutAt)) ? "；「已重置」表示额度提前重置，窗口提前结束" : ""
        }。`
      : "没读到官网的套餐用量历史，这里只列出单独计算的限额。";
    const body = `<p class="ql-hint ql-fold-hint">${hint}</p><div class="ql-list ql-list-windows">${rows.join("")}</div>`;
    return fold("windows", "额度窗口", `${rows.length} 个`, body, folds);
  };

  const renderSources = (v, folds) => {
    if (!v.sources.length) return "";
    const total = v.hasSettled ? v.settled : 0;
    const rows = v.sources
      .map(
        (r) => `
        <div class="ql-list-row">
          <span class="ql-label">${esc(SOURCE_LABELS[r.key] || r.key)}<small>${esc(r.key)}</small></span>
          ${mini(total > EPS ? r.ratio / total : 0, "var(--accent)")}
          <span class="ql-val">${fmtPct(r.ratio)}</span>
          <span class="ql-extra">${total > EPS ? `占 ${fmtPct(r.ratio / total)}` : ""}</span>
        </div>`,
      )
      .join("");
    const top = v.sources[0];
    const meta = top && total > EPS ? `${esc(SOURCE_LABELS[top.key] || top.key)}占 ${fmtPct(top.ratio / total)}` : "";
    const body = `<p class="ql-hint ql-fold-hint">数值是占周额度的比例。记忆整理这类后台任务同样消耗额度。</p><div class="ql-list ql-list-sources">${rows}</div>`;
    return fold("sources", "用量来源", meta, body, folds);
  };

  const dayNote = (d) =>
    [d.missingTokens ? "无 Token 明细" : "", d.shared ? (d.splitBy === "time" ? "跨周期，估算" : "跨周期") : ""].filter(Boolean).join("，");

  const renderDays = (v, folds) => {
    if (!v.days.length) return "";
    const totalWeight = sum(v.days, (d) => d.weight);
    const unit = tokenUnit(Math.max(...v.days.map((d) => d.total)));
    const rows = [...v.days]
      .sort((a, b) => b.ts - a.ts)
      .map(
        (d) => `
        <div class="ql-list-row">
          <span class="ql-label">${esc(fmtDay(d.key))}${dayNote(d) ? `<small>${dayNote(d)}</small>` : ""}</span>
          ${mini(totalWeight > EPS ? d.weight / totalWeight : 0, "var(--accent)")}
          <span class="ql-val">${totalWeight > EPS ? fmtPct(d.weight / totalWeight) : "—"}</span>
          <span class="ql-extra">${d.missingTokens ? "—" : fmtTokensAs(d.total, unit)}</span>
          <span class="ql-extra">${d.missingTokens ? "—" : fmtUsd(d.usd)}</span>
        </div>`,
      )
      .join("");
    const shared = v.days.some((d) => d.shared) ? "一天跨两个周期时，只算属于这个周期的部分。" : "";
    const body = `<p class="ql-hint ql-fold-hint">按 UTC 日期统计；百分比是当天在${v.current ? "本周期" : "这个周期"}已统计用量中的占比。${shared}</p>
      <div class="ql-list ql-list-days">
        <div class="ql-list-row ql-list-head"><span>日期</span><span></span><span>占比</span><span>Tokens</span><span>折合金额</span></div>
        ${rows}
      </div>`;
    return fold("days", "每日明细", `${v.days.length} 天`, body, folds);
  };

  const renderMethod = (folds) =>
    fold(
      "method",
      "这些数字怎么来的",
      "",
      `<ul class="ql-method">
        <li>实时已用来自 ChatGPT 的限额接口，随用随变。</li>
        <li>已结算来自官网「套餐用量历史」，按 UTC 整点结算，所以会比实时少一截；两者之差就是还没结算的用量。</li>
        <li>各模型占周额度是官网数据；同一模型的 Standard 与 Fast 按当天的额度消耗比例拆开。</li>
        <li>Token 来自每日统计。Team 工作区直接给出每个模型的 Token；个人账号每天只有合计，多个模型时按各模型费率反推分配，所以是估算。</li>
        <li>金额按 OpenAI API 公开价格折算，Fast 按 2.5 倍、Ultrafast 按 8 倍，只是等价参考，不是账单。</li>
        <li>整周推算等于已结算时段的金额除以同一时段的已用比例，也就是用满一周额度大约值多少。</li>
        <li>每日统计按 UTC 日期分，一天可能跨两个周期（比如提前重置那天）。这时按官网 5 小时窗口的用量把当天拆开（重置会让 5 小时窗口同时结束，所以分得准），Token 和金额跟着拆；还没结算的先用实时用量估，再不行就按时长估。</li>
      </ul>`,
      folds,
    );

  const renderFooter = () => `
    <footer class="ql-foot">
      <span>Codex 额度透镜 ${VERSION}，由 Wren 和 Claude 制作</span>
      <button type="button" class="ql-link" data-act="diag">导出诊断信息</button>
    </footer>
    <div class="ql-diag-slot"></div>`;

  const renderView = (v) => {
    const folds = readFolds();
    return `
      ${renderHeader(v)}
      ${renderHero(v)}
      ${renderFigures(v)}
      ${renderNotices(v)}
      ${renderModels(v)}
      <div class="ql-folds">
        ${renderWindows(v, folds)}
        ${renderSources(v, folds)}
        ${renderDays(v, folds)}
        ${renderMethod(folds)}
      </div>
      ${renderFooter()}`;
  };

  const renderLoading = () => `
    ${renderHeader(null)}
    <section class="ql-hero">
      <p class="ql-lead">正在读取额度数据…</p>
      <div class="ql-bar ql-bar-loading"><div class="ql-fill"></div></div>
    </section>`;

  const renderError = (message) => `
    ${renderHeader(null)}
    <section class="ql-hero">
      <p class="ql-lead">没能读取额度数据</p>
      <p class="ql-pace">${esc(message)}</p>
      <button type="button" class="ql-btn ql-retry" data-act="refresh">重新读取</button>
    </section>
    ${renderFooter()}`;


  const describe = (value, depth = 0, key = "", maxItems = 3) => {
    if (depth > 8) return "…";
    if (Array.isArray(value)) {
      const items = value.slice(0, maxItems).map((x) => describe(x, depth + 1, key, maxItems));
      return value.length > maxItems ? [...items, `…共 ${value.length} 项`] : items;
    }
    if (value && typeof value === "object") {
      const out = {};
      Object.entries(value)
        .slice(0, 40)
        .forEach(([k, x]) => {
          out[k] = describe(x, depth + 1, k, maxItems);
        });
      return out;
    }
    if (typeof value === "string") {
      const masked = value === "" ? "<empty>" : `<redacted:len=${value.length}>`;
      // 链接里可能带用户 ID，只留域名
      if (/^https?:\/\//i.test(value)) {
        try {
          return `${new URL(value).origin}/<redacted>`;
        } catch {
          return masked;
        }
      }
      if (/@/.test(value) || /^[\w-]{24,}$/.test(value)) return masked;
      if (/email|name|user|account|org|workspace|id$|_id|token|phone|avatar|picture|session/i.test(key) && !/model|limit|window|units|speed/i.test(key)) {
        return masked;
      }
      return value.length > 60 ? `${value.slice(0, 60)}…` : value;
    }
    return value;
  };

  const backendPaths = () =>
    [
      ...new Set(
        (performance.getEntriesByType?.("resource") || [])
          .map((e) => {
            try {
              const url = new URL(e.name, location.href);
              return url.origin === location.origin && url.pathname.startsWith("/backend-api/") ? url.pathname + url.search : null;
            } catch {
              return null;
            }
          })
          .filter(Boolean),
      ),
    ];

  async function exportDiagnostics(root) {
    const slot = root.querySelector(".ql-diag-slot");
    if (!slot) return;
    slot.innerHTML = `<div class="ql-diag"><p class="ql-hint">正在收集…</p></div>`;
    const paths = backendPaths();
    await resolveAccountId();
    const probes = [
      "/backend-api/wham/usage",
      `/backend-api/wham/usage/plan_limit_history?days=${RANGE_DAYS}`,
      "/backend-api/wham/rate-limit-reset-credits",
      ...[/daily-token-usage-breakdown/, /daily-workspace-usage-counts/, /daily-workspace-user-token-usage-breakdown/]
        .map((re) => paths.find((p) => re.test(p)))
        .filter(Boolean),
    ];
    const queue = [...new Set(probes)];
    const samples = [];
    for (let i = 0; i < queue.length; i += 1) {
      const path = queue[i];
      try {
        const body = await api(path);
        const sample = { path, body: describe(body, 0, "", /plan_limit|reset-credits/.test(path) ? 12 : 3) };
        // 历史里窗口很多，抽样会漏掉每周窗口，单独列出来
        if (path.includes("plan_limit_history")) {
          sample.periodCount = asArray(body?.periods).length;
          const bp = (v) => Math.round(n(v) * 10) / 10;
          const models = (p) =>
            Object.fromEntries(
              asArray(asArray(p?.breakdowns).find((b) => b?.dimension === "model")?.rows).map((r) => [modelName(r?.key), bp(r?.basis_points)]),
            );
          const of = (minutes) => asArray(body?.periods).filter((p) => n(p?.window_minutes) === minutes);
          sample.weekly = of(10080).map((p) => [p.starts_at, p.ends_at, bp(p.used_basis_points), Boolean(p.accounting_complete), models(p)]);
          sample.short = of(300).map((p) => [p.starts_at, p.ends_at, bp(p.used_basis_points), models(p)]);
        }
        samples.push(sample);
      } catch (error) {
        samples.push({ path, error: error.message });
        if (path.includes(`days=${RANGE_DAYS}`)) queue.push("/backend-api/wham/usage/plan_limit_history?days=7");
      }
    }
    const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
    const round = (v, k = 1) => (Number.isFinite(v) ? Math.round(v * k) / k : null);
    // 有绝对 credits 时换算成 credits，没有时（Team）就是每日明细里的相对值
    const computed = state
      ? (() => {
          const { quota, cycles, days, mode } = state.data;
          const scale = creditScale(days);
          const amount = (u) => (Number.isFinite(scale) ? round(u * scale) : round(u, 100));
          return {
            mode,
            unit: Number.isFinite(scale) ? "credits" : "relative",
            per100: amount(quota),
            cycles: cycles.map((c) => ({
              start: iso(c.start),
              end: iso(c.end),
              settled: round(c.settled * 100, 100),
              current: c.current,
              cut: c.cut,
              partial: Boolean(c.partial),
              amount: amount(sum(c.days, unitsOf)),
              days: c.days.map((d) => `${d.key}${d.shared ? ` ${d.splitBy} ${amount(unitsOf(d))}` : ""}`),
            })),
            // 日期、相对值、绝对 credits、Token 合计、各模型相对值
            days: days.map((d) => {
              const models = {};
              d.models.forEach((m) => {
                const k = m.speed === "standard" ? m.model : `${m.model}:${m.speed}`;
                if (m.credits > EPS) models[k] = round(m.credits, 100);
              });
              return [d.key, round(unitsOf(d), 100), round(d.absCredits, 10), d.total, models];
            }),
          };
        })()
      : null;
    const report = JSON.stringify(
      {
        script: `Codex 额度透镜 ${VERSION}`,
        page: location.pathname + location.search,
        time: new Date().toISOString(),
        account: accountId ? "已解析" : "未解析",
        paths: paths.filter((p) => /wham|usage|limit/i.test(p)).map((p) => p.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "<uuid>")),
        computed,
        samples,
      },
      null,
      2,
    );
    slot.innerHTML = `
      <div class="ql-diag">
        <div class="ql-block-head"><h3>诊断信息</h3><button type="button" class="ql-btn" data-act="copy">复制</button></div>
        <p class="ql-hint">个人信息已打码，可以直接发给开发者。</p>
        <textarea readonly></textarea>
      </div>`;
    const textarea = slot.querySelector("textarea");
    textarea.value = report;
    slot.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  async function copyDiagnostics(root, button) {
    const textarea = root.querySelector(".ql-diag textarea");
    if (!textarea) return;
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    let ok = false;
    try {
      await navigator.clipboard.writeText(textarea.value);
      ok = true;
    } catch {
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
    }
    button.textContent = ok ? "已复制" : "请手动复制";
    setTimeout(() => {
      button.textContent = "复制";
    }, 1600);
  }


  const STYLE = `
#cql-root, #cql-launch {
  --ink: #1A2130;
  --muted: #667085;
  --faint: #9AA1AE;
  --line: #E7E9EF;
  --track: #EDF0F5;
  --sheet: #FFFFFF;
  --wash: #F5F6F9;
  --accent: #3554D1;
  --accent-soft: rgba(53, 84, 209, 0.42);
  --warn: #8A5300;
  --warn-bg: #FFF5E3;
  --shadow: 0 32px 80px -24px rgba(16, 24, 40, 0.38), 0 0 0 1px rgba(16, 24, 40, 0.06);
  --sans: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif;
  --round: ui-rounded, "SF Pro Rounded", -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
}
html.dark #cql-root, html.dark #cql-launch {
  --ink: #E9ECF2; --muted: #9BA3B4; --faint: #6F7788; --line: #2A2F3A; --track: #272C36;
  --sheet: #181B22; --wash: #20242D; --accent: #8399FF; --accent-soft: rgba(131, 153, 255, 0.45);
  --warn: #F2C27A; --warn-bg: #2E2616;
  --shadow: 0 32px 80px -24px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(255, 255, 255, 0.07);
}
@media (prefers-color-scheme: dark) {
  html:not(.light) #cql-root, html:not(.light) #cql-launch {
    --ink: #E9ECF2; --muted: #9BA3B4; --faint: #6F7788; --line: #2A2F3A; --track: #272C36;
    --sheet: #181B22; --wash: #20242D; --accent: #8399FF; --accent-soft: rgba(131, 153, 255, 0.45);
    --warn: #F2C27A; --warn-bg: #2E2616;
    --shadow: 0 32px 80px -24px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(255, 255, 255, 0.07);
  }
}

#cql-root {
  position: fixed; z-index: 2147483647; display: none;
  left: 50%; top: 24px; width: min(780px, calc(100vw - 24px));
  max-height: calc(100vh - 48px); max-height: calc(100dvh - 48px);
  overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch;
  background: var(--sheet); color: var(--ink); border-radius: 22px; box-shadow: var(--shadow);
  font-family: var(--sans); font-size: 14px; line-height: 1.5; text-align: left;
  -webkit-font-smoothing: antialiased; -webkit-text-size-adjust: 100%;
  pointer-events: auto !important;
}
#cql-root * {
  box-sizing: border-box; margin: 0; padding: 0; border: 0; background: none;
  font: inherit; color: inherit; letter-spacing: normal; text-transform: none; text-decoration: none;
}
#cql-root :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 8px; }

#cql-root .ql-head {
  position: sticky; top: 0; z-index: 3; display: grid; grid-template-columns: minmax(0, 1fr) auto;
  grid-template-areas: "title actions" "sub actions"; align-items: start; column-gap: 16px;
  padding: 22px 28px 12px; background: var(--sheet);
}
#cql-root .ql-head h2 { grid-area: title; font-size: 17px; font-weight: 650; line-height: 1.3; }
#cql-root .ql-head p {
  grid-area: sub; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; margin-top: 2px;
  color: var(--muted); font-size: 12.5px; font-variant-numeric: tabular-nums;
}
#cql-root .ql-actions { grid-area: actions; display: flex; gap: 6px; }
#cql-root .ql-btn {
  display: inline-flex; align-items: center; justify-content: center; height: 32px; padding: 0 13px;
  border-radius: 999px; background: var(--wash); color: var(--ink); font-size: 13px; font-weight: 550; cursor: pointer;
  -webkit-appearance: none; appearance: none;
}
@media (hover: hover) {
  #cql-root .ql-btn:hover { background: var(--track); }
  #cql-root button.ql-row:hover { background: var(--wash); }
  #cql-root .ql-nav-btn:not(:disabled):hover { background: var(--track); }
  #cql-launch:hover { opacity: 0.92; }
}
#cql-root .ql-icon { width: 32px; padding: 0; font-size: 20px; line-height: 1; }
#cql-root .ql-nav { display: inline-flex; align-items: center; gap: 6px; }
#cql-root .ql-nav-btn {
  display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; margin: -2px 0; padding-bottom: 2px;
  border-radius: 50%; background: var(--wash); color: var(--ink); font-size: 17px; line-height: 1; cursor: pointer;
  -webkit-appearance: none; appearance: none;
}
#cql-root .ql-nav-btn:disabled { opacity: 0.35; cursor: default; }
#cql-root .ql-head .ql-tag { margin-left: 6px; }
#cql-root .ql-retry { margin-top: 16px; }

#cql-root .ql-hero { padding: 10px 28px 24px; }
#cql-root .ql-top { display: flex; align-items: flex-end; flex-wrap: wrap; gap: 6px 20px; }
#cql-root .ql-num {
  font-family: var(--round); font-size: 76px; font-weight: 600; line-height: 0.92;
  letter-spacing: -0.04em; font-variant-numeric: tabular-nums;
}
#cql-root .ql-num small { margin-left: 3px; font-size: 32px; font-weight: 500; letter-spacing: 0; color: var(--muted); }
#cql-root .ql-top-text { flex: 1 1 260px; padding-bottom: 6px; }
#cql-root .ql-lead { font-size: 15px; font-weight: 600; }
#cql-root .ql-pace { margin-top: 2px; max-width: 34em; color: var(--muted); font-size: 13.5px; }

#cql-root .ql-bar { position: relative; height: 18px; margin-top: 24px; border-radius: 9px; background: var(--track); }
#cql-root .ql-fill {
  position: absolute; inset: 0; display: flex; gap: 2px; overflow: hidden; border-radius: 9px;
  animation: ql-reveal 0.9s cubic-bezier(0.22, 1, 0.36, 1) both;
}
#cql-root .ql-seg { flex: none; height: 100%; min-width: 3px; }
#cql-root .ql-seg-minor { background: var(--faint); }
#cql-root .ql-seg-pending { background: repeating-linear-gradient(-45deg, var(--accent-soft) 0 3px, transparent 3px 7px); }
#cql-root .ql-bar-loading { margin-top: 18px; }
#cql-root .ql-bar-loading .ql-fill { width: 30%; background: var(--line); animation: ql-pulse 1.2s ease-in-out infinite alternate; }
#cql-root .ql-marker {
  position: absolute; top: -6px; bottom: -6px; width: 2px; margin-left: -1px; border-radius: 1px; background: var(--ink);
}
#cql-root .ql-marker-label {
  position: absolute; top: 100%; margin-top: 9px; transform: translateX(-50%);
  white-space: nowrap; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums;
}
#cql-root .ql-marker-label.is-start { transform: translateX(-2px); }
#cql-root .ql-marker-label.is-end { transform: translateX(calc(-100% + 2px)); }

#cql-root .ql-legend { display: flex; flex-wrap: wrap; gap: 8px 26px; margin-top: 20px; }
#cql-root .ql-has-marker + .ql-legend { margin-top: 38px; }
#cql-root .ql-key { display: flex; align-items: baseline; gap: 7px; color: var(--muted); font-size: 13px; }
#cql-root .ql-key b { color: var(--ink); font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; }
#cql-root .ql-key-note { color: var(--faint); font-size: 12px; }
#cql-root .ql-swatch { flex: none; align-self: center; width: 14px; height: 8px; border-radius: 3px; }
#cql-root .ql-swatch-pending { background: repeating-linear-gradient(-45deg, var(--accent-soft) 0 2px, transparent 2px 4px); box-shadow: inset 0 0 0 1px var(--accent-soft); }
#cql-root .ql-swatch-empty { background: var(--track); box-shadow: inset 0 0 0 1px var(--line); }

#cql-root .ql-short {
  display: flex; align-items: center; flex-wrap: wrap; gap: 6px 12px; margin-top: 18px; padding-top: 16px;
  border-top: 1px solid var(--line); color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums;
}
#cql-root .ql-short b { color: var(--ink); font-weight: 600; }
#cql-root .ql-short .ql-mini { width: 120px; }
#cql-root .ql-mini { position: relative; display: block; height: 6px; overflow: hidden; border-radius: 3px; background: var(--track); }
#cql-root .ql-mini i { position: absolute; top: 0; bottom: 0; left: 0; border-radius: 3px; background: var(--ink); }

#cql-root .ql-figures {
  display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); margin: 0 28px;
  border-top: 1px solid var(--line); border-bottom: 1px solid var(--line);
}
#cql-root .ql-figure { padding: 16px 0 15px; }
#cql-root .ql-figure + .ql-figure { padding-left: 20px; border-left: 1px solid var(--line); }
#cql-root .ql-figure b {
  display: block; font-family: var(--round); font-size: 25px; font-weight: 600; line-height: 1.2;
  letter-spacing: -0.02em; font-variant-numeric: tabular-nums;
}
#cql-root .ql-figure span { display: block; margin-top: 2px; color: var(--muted); font-size: 12.5px; }

#cql-root .ql-notice { margin: 14px 28px 0; padding: 10px 14px; border-radius: 12px; background: var(--warn-bg); color: var(--warn); font-size: 13px; }

#cql-root .ql-block { padding: 26px 28px 8px; }
#cql-root .ql-block-head { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 4px 16px; margin-bottom: 10px; }
#cql-root .ql-block h3, #cql-root .ql-diag h3 { font-size: 15px; font-weight: 650; }
#cql-root .ql-hint { color: var(--muted); font-size: 12.5px; }
#cql-root .ql-empty { margin-top: 8px; color: var(--muted); }

#cql-root .ql-cols, #cql-root .ql-row {
  display: grid; grid-template-columns: 12px minmax(0, 1fr) 82px 76px 82px; align-items: center; column-gap: 14px;
}
#cql-root .ql-cols { padding: 0 10px 6px; color: var(--faint); font-size: 12px; }
#cql-root .ql-cols span:nth-child(n + 3) { text-align: right; }
#cql-root .ql-row {
  width: 100%; padding: 11px 10px; border-radius: 12px; text-align: left; cursor: pointer;
  font-variant-numeric: tabular-nums; -webkit-appearance: none; appearance: none;
}
#cql-root .ql-row[aria-expanded="true"] { background: var(--wash); }
#cql-root .ql-row-total { margin-top: 4px; border-top: 1px solid var(--line); border-radius: 0; cursor: default; font-weight: 600; }
#cql-root .ql-dot { width: 10px; height: 10px; border-radius: 50%; }
#cql-root .ql-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 550; }
#cql-root .ql-tag {
  display: inline-block; margin-left: 8px; padding: 0 7px; border-radius: 999px; background: var(--track);
  color: var(--muted); font-size: 11.5px; font-weight: 550; line-height: 18px; vertical-align: 1px;
}
#cql-root .ql-cell { text-align: right; }
#cql-root .c-quota { font-weight: 650; }
#cql-root .c-tok, #cql-root .c-usd { color: var(--muted); }
#cql-root .ql-row-total .c-tok, #cql-root .ql-row-total .c-usd { color: var(--ink); }
#cql-root .ql-detail { margin: 0 10px 10px 36px; padding: 6px 0 8px; color: var(--muted); font-size: 13px; }
#cql-root .ql-detail[hidden] { display: none; }
#cql-root .ql-detail p + p { margin-top: 4px; }
#cql-root .ql-parts { display: flex; flex-wrap: wrap; gap: 6px 26px; margin-bottom: 8px; }
#cql-root .ql-parts span { display: block; font-size: 12px; }
#cql-root .ql-parts b { display: block; color: var(--ink); font-weight: 600; font-variant-numeric: tabular-nums; }
#cql-root .ql-calc { color: var(--ink); font-variant-numeric: tabular-nums; }

#cql-root .ql-folds { margin-top: 18px; }
#cql-root .ql-fold { margin: 0 28px; border-top: 1px solid var(--line); }
#cql-root .ql-fold > summary {
  display: flex; align-items: center; gap: 12px; padding: 15px 0; list-style: none; cursor: pointer;
  font-size: 15px; font-weight: 650;
}
#cql-root .ql-fold > summary::-webkit-details-marker { display: none; }
#cql-root .ql-sum-meta { margin-left: auto; color: var(--muted); font-size: 12.5px; font-weight: 400; }
#cql-root .ql-chev {
  flex: none; width: 7px; height: 7px; margin: -3px 4px 0 0; border-right: 1.5px solid var(--muted); border-bottom: 1.5px solid var(--muted);
  transform: rotate(45deg); transition: transform 0.2s ease;
}
#cql-root .ql-sum-meta + .ql-chev { margin-left: 0; }
#cql-root .ql-fold > summary > span:first-child + .ql-chev { margin-left: auto; }
#cql-root .ql-fold[open] .ql-chev { margin-top: 3px; transform: rotate(225deg); }
#cql-root .ql-fold-body { padding-bottom: 18px; }
#cql-root .ql-fold-hint { margin-bottom: 8px; }

#cql-root .ql-list-row {
  display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(70px, 1fr) 64px 72px; align-items: center; gap: 14px;
  padding: 8px 0; font-size: 13px; font-variant-numeric: tabular-nums;
}
#cql-root .ql-list-windows .ql-list-row { grid-template-columns: minmax(0, 1.4fr) minmax(70px, 1fr) 64px 112px; }
#cql-root .ql-list-days .ql-list-row { grid-template-columns: 92px minmax(60px, 1fr) 60px 70px 76px; }
#cql-root .ql-list-head { padding-bottom: 2px; color: var(--faint); font-size: 12px; }
#cql-root .ql-list-head span:nth-child(n + 3) { text-align: right; }
#cql-root .ql-label { min-width: 0; font-weight: 550; }
#cql-root .ql-label small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: 12px; font-weight: 400; }
#cql-root .ql-val { text-align: right; font-weight: 650; }
#cql-root .ql-extra { text-align: right; white-space: nowrap; color: var(--muted); }
#cql-root .ql-list-row.is-current .ql-label { color: var(--accent); }
#cql-root .ql-method { padding-left: 1.1em; color: var(--muted); font-size: 13px; max-width: 46em; }
#cql-root .ql-method li + li { margin-top: 4px; }

#cql-root .ql-foot {
  display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px 16px;
  margin-top: 6px; padding: 16px 28px 22px; border-top: 1px solid var(--line); color: var(--faint); font-size: 12px;
}
#cql-root .ql-link { color: var(--muted); font-size: 12px; text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
#cql-root .ql-diag { padding: 0 28px 26px; }
#cql-root .ql-diag textarea {
  display: block; width: 100%; height: 240px; margin-top: 10px; padding: 12px; border-radius: 12px;
  background: var(--wash); color: var(--ink); font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  resize: vertical; -webkit-user-select: text; user-select: text;
}

#cql-launch {
  position: fixed; right: 20px; bottom: 20px; z-index: 2147483646; display: none; align-items: center; gap: 9px;
  height: 40px; margin: 0; padding: 0 16px 0 14px; border: 0; border-radius: 999px;
  background: var(--ink); color: var(--sheet); box-shadow: 0 12px 30px -10px rgba(16, 24, 40, 0.5);
  font: 600 13.5px/1 var(--sans); cursor: pointer; pointer-events: auto !important;
  -webkit-appearance: none; appearance: none;
}
#cql-launch:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
#cql-launch .ql-glyph { position: relative; display: block; width: 20px; height: 8px; border-radius: 3px; box-shadow: inset 0 0 0 1.5px currentColor; }
#cql-launch .ql-glyph i { position: absolute; top: 0; bottom: 0; left: 0; width: 58%; border-radius: 3px; background: currentColor; }

@keyframes ql-reveal { from { clip-path: inset(0 100% 0 0); } to { clip-path: inset(0 0 0 0); } }
@keyframes ql-pulse { from { opacity: 0.5; } to { opacity: 1; } }
#cql-root.ql-static .ql-fill { animation: none; }
@media (prefers-reduced-motion: reduce) {
  #cql-root .ql-fill, #cql-root .ql-bar-loading .ql-fill { animation: none; }
  #cql-root .ql-chev { transition: none; }
}

@media (max-width: 600px) {
  #cql-root { border-radius: 18px; font-size: 13.5px; }
  #cql-root .ql-head { grid-template-areas: "title actions" "sub sub"; padding: 18px 18px 10px; }
  #cql-root .ql-head h2 { align-self: center; }
  #cql-root .ql-head p { margin-top: 8px; }
  #cql-root .ql-mode { display: none; }
  #cql-root .ql-nav-btn { width: 28px; height: 28px; }
  #cql-root .ql-hero { padding: 6px 18px 20px; }
  #cql-root .ql-num { font-size: 62px; }
  #cql-root .ql-num small { font-size: 26px; }
  #cql-root .ql-legend { gap: 8px 18px; }
  #cql-root .ql-figures { margin: 0 18px; }
  #cql-root .ql-figure + .ql-figure { padding-left: 12px; }
  #cql-root .ql-figure b { font-size: 20px; }
  #cql-root .ql-figure span { font-size: 11.5px; }
  #cql-root .ql-notice { margin: 12px 18px 0; }
  #cql-root .ql-block { padding: 22px 18px 6px; }
  #cql-root .ql-cols { display: none; }
  #cql-root .ql-row {
    grid-template-columns: 12px minmax(0, 1fr) auto; grid-template-areas: "dot name quota" ". tok usd";
    row-gap: 1px; column-gap: 10px; padding: 10px 8px;
  }
  #cql-root .ql-dot { grid-area: dot; }
  #cql-root .ql-name { grid-area: name; }
  #cql-root .c-quota { grid-area: quota; }
  #cql-root .c-tok { grid-area: tok; text-align: left; font-size: 12.5px; }
  #cql-root .c-tok::after { content: " tokens"; }
  #cql-root .c-tok.is-none::after { content: none; }
  #cql-root .c-usd { grid-area: usd; font-size: 12.5px; }
  #cql-root .ql-row-total span:first-child { display: none; }
  #cql-root .ql-detail { margin: 0 8px 8px 30px; }
  #cql-root .ql-fold { margin: 0 18px; }
  #cql-root .ql-list-row, #cql-root .ql-list-windows .ql-list-row, #cql-root .ql-list-days .ql-list-row {
    grid-template-columns: minmax(0, 1fr) auto auto; grid-template-areas: "label val extra" "bar bar bar"; gap: 4px 12px;
  }
  #cql-root .ql-list-row > :nth-child(1) { grid-area: label; }
  #cql-root .ql-list-row > :nth-child(2) { grid-area: bar; }
  #cql-root .ql-list-row > :nth-child(3) { grid-area: val; }
  #cql-root .ql-list-row > :nth-child(4) { grid-area: extra; }
  #cql-root .ql-list-days .ql-list-row { grid-template-columns: minmax(0, 1fr) auto auto auto; grid-template-areas: "label val extra usd" "bar bar bar bar"; }
  #cql-root .ql-list-days .ql-list-row > :nth-child(5) { grid-area: usd; }
  #cql-root .ql-list-head { display: none; }
  #cql-root .ql-foot { padding: 14px 18px 20px; }
  #cql-root .ql-diag { padding: 0 18px 22px; }
  #cql-launch { right: 14px; bottom: 14px; }
}
`;


  const isTargetPage = () => TARGET_PATHS.some((p) => location.pathname.startsWith(p));

  const fitPanel = () => {
    const root = document.getElementById("cql-root");
    if (!root || root.style.display !== "block") return;
    const vv = window.visualViewport;
    const vw = vv ? vv.width : document.documentElement.clientWidth;
    const vh = vv ? vv.height : window.innerHeight;
    const margin = vw <= 600 ? 8 : 24;
    const width = Math.min(780, vw - margin * 2);
    Object.assign(root.style, {
      left: `${(vv ? vv.offsetLeft : 0) + (vw - width) / 2}px`,
      top: `${(vv ? vv.offsetTop : 0) + margin}px`,
      width: `${width}px`,
      maxHeight: `${vh - margin * 2}px`,
    });
  };

  let loading = false;
  let state = null;

  const renderState = (root) => {
    const view = buildView(state.data, state.index);
    root.innerHTML = renderView(view);
  };

  // 从按钮打开时回到当前周期；点「刷新」时停在正在看的那个周期
  async function open(keep) {
    const root = document.getElementById("cql-root");
    if (!root || loading) return;
    loading = true;
    const keepStart = keep === true && state ? state.data.cycles[state.index]?.start : NaN;
    root.style.display = "block";
    root.classList.remove("ql-static");
    root.innerHTML = renderLoading();
    fitPanel();
    root.scrollTop = 0;
    try {
      const data = await load();
      state = { data, index: Math.max(0, data.cycles.findIndex((c) => Math.abs(c.start - keepStart) < 60000)) };
      renderState(root);
    } catch (error) {
      console.error("[Codex 额度透镜]", error);
      root.innerHTML = renderError(error?.message || String(error));
    } finally {
      loading = false;
      fitPanel();
    }
  }

  const close = () => {
    const root = document.getElementById("cql-root");
    if (root) root.style.display = "none";
  };

  const showCycle = (root, act) => {
    if (!state) return;
    const index = state.index + (act === "older" ? 1 : -1);
    if (index < 0 || index >= state.data.cycles.length) return;
    state.index = index;
    root.classList.add("ql-static");
    renderState(root);
    const again = root.querySelector(`[data-act="${act}"]:not(:disabled)`) || root.querySelector(".ql-nav-btn:not(:disabled)");
    again?.focus();
  };

  const onRootClick = (event) => {
    const root = event.currentTarget;
    const action = event.target.closest("[data-act]");
    if (action) {
      const act = action.dataset.act;
      if (act === "close") close();
      else if (act === "refresh") open(true);
      else if (act === "older" || act === "newer") showCycle(root, act);
      else if (act === "diag") exportDiagnostics(root);
      else if (act === "copy") copyDiagnostics(root, action);
      return;
    }
    const row = event.target.closest("button.ql-row");
    if (row) {
      const detail = root.querySelector(`[data-detail="${row.dataset.row}"]`);
      const expanded = row.getAttribute("aria-expanded") === "true";
      row.setAttribute("aria-expanded", String(!expanded));
      if (detail) detail.hidden = expanded;
    }
  };

  const onRootToggle = (event) => {
    const details = event.target;
    if (details?.matches?.("details[data-fold]")) writeFold(details.dataset.fold, details.open);
  };

  const isolate = (el) => {
    ["pointerdown", "mousedown", "touchstart"].forEach((type) => el.addEventListener(type, (e) => e.stopPropagation()));
  };

  const ensureUI = () => {
    if (!document.body) return;

    let launch = document.getElementById("cql-launch");
    if (!launch) {
      launch = document.createElement("button");
      launch.id = "cql-launch";
      launch.type = "button";
      launch.innerHTML = `<span class="ql-glyph" aria-hidden="true"><i></i></span><span>Codex 额度</span>`;
      launch.addEventListener("click", open);
      isolate(launch);
      document.body.appendChild(launch);
    }

    let root = document.getElementById("cql-root");
    if (!root) {
      root = document.createElement("div");
      root.id = "cql-root";
      root.setAttribute("role", "dialog");
      root.setAttribute("aria-label", "Codex 额度");
      root.addEventListener("click", onRootClick);
      root.addEventListener("toggle", onRootToggle, true);
      isolate(root);
      document.body.appendChild(root);
    }

    const onTarget = isTargetPage();
    launch.style.display = onTarget ? "inline-flex" : "none";
    if (!onTarget) root.style.display = "none";
  };

  const style = document.createElement("style");
  style.textContent = STYLE;
  (document.head || document.documentElement).appendChild(style);

  try {
    performance.setResourceTimingBufferSize?.(2000);
  } catch {
    // Safari 旧版本不支持
  }

  window.visualViewport?.addEventListener("resize", fitPanel);
  window.visualViewport?.addEventListener("scroll", fitPanel);
  window.addEventListener("resize", fitPanel);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });

  ensureUI();
  setInterval(ensureUI, 1000);
})();
