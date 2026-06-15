// Dashboard Refresh Golden — release-gate test (node:test).
//
// Wired as `npm run eval:dashboard-refresh-golden`. Hermetic: the core stubs
// clustering + embeddings, so no provider keys / network are needed. Guards the
// failed E2E (1x "General Updates", Spelling Bee liveblog stack, no Reuters,
// clustering fallback shipped) against recurrence.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DASHBOARD_GOLDEN_SCENARIO_IDS,
  loadGold,
  runDashboardRefreshGolden,
} from "./dashboard-refresh-golden-core.mjs";

test("golden scenario registry lists the 5 locked scenarios in order", () => {
  assert.deepEqual(Array.from(DASHBOARD_GOLDEN_SCENARIO_IDS), [
    "gold-01-fail-closed",
    "gold-01b-deterministic-rescue",
    "gold-02-healthy-path",
    "gold-03-liveblog-dedupe",
    "gold-04-recall-floor",
  ]);
});

test("gold fixture loads and carries persona + on-beat + liveblog + weak-semantic rows", () => {
  const gold = loadGold();
  assert.ok(gold.persona && Array.isArray(gold.persona.keywords), "persona.keywords present");
  assert.ok(gold.onBeatItems.length >= 4, "at least 4 on-beat items");
  assert.equal(gold.liveblogVariants.length, 4, "exactly 4 Spelling Bee liveblog variants");
  assert.ok(gold.failClosedClusteringItem && gold.failClosedClusteringItem.sourceId === "fail-closed-1");
  assert.ok(gold.weakSemanticItem && gold.weakSemanticItem.sourceId === "weak-semantic-1");
  // Persona must include both Batch 1 publishers — the failed E2E lost Reuters.
  assert.ok(gold.persona.traditionalSources.includes("Reuters"));
  assert.ok(gold.persona.traditionalSources.includes("The Washington Post"));
});

test("all golden scenarios pass against the live pipeline (hermetic)", async () => {
  const { results, summary } = await runDashboardRefreshGolden();
  assert.equal(summary.total, 5);
  assert.equal(
    summary.passed,
    5,
    `failed: ${JSON.stringify(results.filter((r) => !r.ok), null, 2)}`
  );
  assert.equal(summary.hardFail, false);
});

test("each golden result carries id, intent, ok, reasons, diagnostics", async () => {
  const { results } = await runDashboardRefreshGolden();
  for (const r of results) {
    assert.ok(typeof r.id === "string" && r.id.length > 0, `${r.id} missing id`);
    assert.ok(typeof r.intent === "string" && r.intent.length > 0, `${r.id} missing intent`);
    assert.equal(typeof r.ok, "boolean", `${r.id} ok not boolean`);
    assert.ok(Array.isArray(r.reasons), `${r.id} reasons not array`);
    assert.ok(r.diagnostics && typeof r.diagnostics === "object", `${r.id} diagnostics missing`);
  }
});
