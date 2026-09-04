// Dashboard Spanish Recall — release-gate test (node:test).
//
// Wired as `npm run eval:dashboard-spanish-recall`. Hermetic: the core injects
// a deterministic ES→EN translateFn + cluster stubs, so no provider keys /
// network are needed. Proves Phase 3 Slice 14 translation-first normalization:
// Spanish RSS-shaped items reach the clustering pool via normalized English
// evidence (and would NOT without it), with a degraded-path scenario showing the
// refresh still completes on partial translation failure.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SPANISH_RECALL_SCENARIO_IDS,
  runDashboardSpanishRecall,
} from "./dashboard-spanish-recall-core.mjs";

test("spanish-recall scenario registry lists the 3 locked scenarios in order", () => {
  assert.deepEqual(Array.from(SPANISH_RECALL_SCENARIO_IDS), [
    "es-01-baseline-no-translation",
    "es-02-translated-recall",
    "es-03-degraded-partial-failure",
  ]);
});

test("all spanish-recall scenarios pass against the live pipeline (hermetic)", async () => {
  const { results, summary } = await runDashboardSpanishRecall();
  assert.equal(summary.total, 3);
  assert.equal(
    summary.passed,
    3,
    `failed: ${JSON.stringify(results.filter((r) => !r.ok), null, 2)}`
  );
  assert.equal(summary.hardFail, false);
});

test("each spanish-recall result carries id, intent, ok, reasons, diagnostics", async () => {
  const { results } = await runDashboardSpanishRecall();
  for (const r of results) {
    assert.ok(typeof r.id === "string" && r.id.length > 0, `${r.id} missing id`);
    assert.ok(typeof r.intent === "string" && r.intent.length > 0, `${r.id} missing intent`);
    assert.equal(typeof r.ok, "boolean", `${r.id} ok not boolean`);
    assert.ok(Array.isArray(r.reasons), `${r.id} reasons not array`);
    assert.ok(r.diagnostics && typeof r.diagnostics === "object", `${r.id} diagnostics missing`);
  }
});
