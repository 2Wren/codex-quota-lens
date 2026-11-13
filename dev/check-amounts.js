#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../codex-quota-lens.user.js"), "utf8");
const context = vm.createContext({ window: {} });
const end = source.indexOf("  const STYLE =");
assert.ok(end > 0, "找不到样式常量前的计算与渲染代码");
vm.runInContext(source.slice(0, end) + "globalThis.check = { buildTeamDays, buildCycles, buildView, renderFigures, renderModels, renderWindows, renderNotices };})();", context);
const { buildTeamDays, buildCycles, buildView, renderFigures, renderModels, renderWindows, renderNotices } = context.check;
const model = (name, input, cached = 0, output = 0) => ({
  model: name, speed: "standard", credits: 0,
  uncached_text_input_tokens: input, cached_text_input_tokens: cached, text_output_tokens: output,
  text_total_tokens: input + cached + output,
});
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} 应等于 ${b}`);

// 11/11 来自用户诊断；11/12 为合成数据，用来验证未结算模型与金额拆分。
const days = buildTeamDays([
  { date: "2026-11-11", models: [model("gpt-6.1-sol", 1488425, 14062720, 79089)] },
  { date: "2026-11-12", models: [model("gpt-6.1-sol", 4655000), model("gpt-6-astra", 851000)] },
], []);
const start = Date.parse("2026-11-11T07:59:39Z");
const finish = Date.parse("2026-11-18T07:59:39Z");
const data = {
  mode: "team", usage: {}, now: Date.parse("2026-11-12T18:01:03Z"), minutes: 10080,
  history: { asOf: Date.parse("2026-11-12T00:00:00Z"), periods: [] },
  cycles: [{ start, end: finish, until: finish, known: true, current: true, partial: false,
    settled: 0.0533569816, live: 0.49, livePercent: 49, days,
    breakdowns: { model: [{ key: "gpt-6.1-sol", ratio: 0.0533569816 }] },
  }],
};
const checkTotals = (v) => {
  close(v.amountParts[0].usd + v.amountParts[1].usd, v.usd);
  assert.equal(v.amountParts[0].total + v.amountParts[1].total, v.tokens);
  for (const m of v.models) {
    for (const field of ["usd", "input", "cached", "output", "total"]) {
      close(m.amountParts[0][field] + m.amountParts[1][field], m[field]);
    }
  }
};
let view = buildView(data, 0);
checkTotals(view);
close(view.amountParts[0].usd, 5.174012);
close(view.amountParts[1].usd, 17.82);
assert.equal(view.projectedUsd.toFixed(2), "96.97");
const sol = view.models.find((m) => m.model === "gpt-6.1-sol");
close(sol.amountParts[1].usd, 9.31);
const astra = view.models.find((m) => m.model === "gpt-6-astra");
assert.equal(astra.amountParts[0].usd, 0);
assert.equal(astra.unsettled, true);
assert.match(renderFigures(view), /\$5\.17（已结算）/);
assert.match(renderFigures(view), /\$17\.82（未结算）/);
assert.match(renderModels(view), /已结算时段/);
assert.match(renderModels(view), /未结算时段/);
assert.match(renderModels(view), /\$9\.31（未结算）/);

data.history.asOf = Date.parse("2026-11-13T00:00:00Z");
view = buildView(data, 0);
checkTotals(view);
assert.equal(view.amountParts[1].usd, 0);
data.history.asOf = Date.parse("2026-11-11T00:00:00Z");
data.cycles[0].settled = 0;
data.cycles[0].breakdowns = {};
view = buildView(data, 0);
checkTotals(view);
assert.equal(view.amountParts[0].usd, 0);

data.history = null;
data.cycles[0].settled = NaN;
view = buildView(data, 0);
assert.equal(view.amountParts, null);
assert.equal(view.models[0].amountParts, undefined);
assert.match(renderFigures(view), /无法区分已结算与未结算/);
assert.doesNotMatch(renderModels(view), /ql-detail-label/);

data.history = { asOf: Date.parse("2026-11-12T00:00:00Z"), periods: [] };
data.cycles[0].settled = 0.1;
data.cycles[0].days = buildTeamDays([
  { date: "2026-11-11", models: [model("unknown-model", 100)] },
], [{ date: "2026-11-12", models: [{ model: "gpt-6.1-sol", credits: 10 }] }]);
view = buildView(data, 0);
checkTotals(view);
assert.equal(view.amountParts[0].unknownPricing, true);
assert.equal(view.missingDays, 1);
assert.equal(view.amountParts[1].usd, 0);
assert.match(renderModels(view), /没有公开 API 价格/);
assert.match(renderModels(view), /没有 Token 明细/);

const period = { start, end: finish, minutes: 10080, used: 0.1, complete: false, breakdowns: {} };
const cycles = buildCycles({ current: period, periods: [period], asOf: data.history.asOf },
  { limit_window_seconds: 604800, used_percent: 49 }, { start, end: finish, known: true }, data.now);
assert.equal(cycles[0].incomplete, true);
data.cycles[0].incomplete = cycles[0].incomplete;
view = buildView(data, 0);
assert.match(renderNotices(view), /数据可能不完整/);
for (const state of [
  { end: start + 18000000 },
  { end: finish },
  { end: finish, cutAt: start + 18000000 },
]) {
  view.periods = [{ ...period, minutes: 300, ...state }];
  const html = renderWindows(view, {});
  assert.match(html, /class="ql-window-incomplete"/);
  assert.doesNotMatch(html, /未核完|数值一般不再变化/);
}
view.periods[0].complete = true;
assert.doesNotMatch(renderWindows(view, {}), /class="ql-window-incomplete"/);
console.log("通过：金额与 Token 拆分守恒、真实结算金额、新模型、全结算、未结算、缺历史、未知价格、缺 Token 和数据完整性提示。");
