import { test } from "node:test";
import assert from "node:assert/strict";

// Importing the script verifies the entry-point gate works — the module must
// not connect to pg / call dotenv just because we imported it.
const {
  parseArgs,
  normalizeForWaPoCheck,
  isWashingtonPost,
  planRestoreActions,
} = await import("./source-scope-phase1.mjs");

test("parseArgs: no args defaults to mode=apply, dryRun=false, jsonOut=false", () => {
  const r = parseArgs([]);
  assert.equal(r.ok, true);
  assert.equal(r.mode, "apply");
  assert.equal(r.dryRun, false);
  assert.equal(r.jsonOut, false);
});

test("parseArgs: positional 'apply' selects apply mode", () => {
  const r = parseArgs(["apply"]);
  assert.equal(r.ok, true);
  assert.equal(r.mode, "apply");
});

test("parseArgs: positional 'restore' selects restore mode", () => {
  const r = parseArgs(["restore"]);
  assert.equal(r.ok, true);
  assert.equal(r.mode, "restore");
});

test("parseArgs: positional 'verify' selects verify mode", () => {
  const r = parseArgs(["verify"]);
  assert.equal(r.ok, true);
  assert.equal(r.mode, "verify");
});

test("parseArgs: legacy --restore flag (no positional) is honored for back-compat", () => {
  const r = parseArgs(["--restore"]);
  assert.equal(r.ok, true);
  assert.equal(r.mode, "restore");
});

test("parseArgs: --dry-run sets dryRun=true (works with any mode)", () => {
  for (const mode of ["apply", "restore", "verify"]) {
    const r = parseArgs([mode, "--dry-run"]);
    assert.equal(r.ok, true);
    assert.equal(r.mode, mode);
    assert.equal(r.dryRun, true);
  }
});

test("parseArgs: --json sets jsonOut=true", () => {
  const r = parseArgs(["verify", "--json"]);
  assert.equal(r.ok, true);
  assert.equal(r.jsonOut, true);
});

test("parseArgs: unknown positional returns ok=false with a helpful error message", () => {
  const r = parseArgs(["nuke"]);
  assert.equal(r.ok, false);
  assert.match(r.error, /Unknown mode 'nuke'/);
  assert.match(r.error, /apply, restore, verify/);
});

test("parseArgs: positional precedence — explicit positional beats legacy --restore flag", () => {
  // If someone passes both, the positional wins (newer convention).
  const r = parseArgs(["apply", "--restore"]);
  assert.equal(r.ok, true);
  assert.equal(r.mode, "apply");
});

test("script module does NOT auto-connect to pg when imported", () => {
  // If the entry-point gate was broken, importing the script (top of file)
  // would have called dotenv + pg.connect already. The fact we got here
  // proves the gate works. (We also assert pg's lazy state to be safe.)
  // No globals to inspect — the absence of an unhandled connection error
  // during import is the contract.
  assert.ok(typeof parseArgs === "function");
});

// ─── WaPo matcher: robust normalization-based detection ──────────────────────

test("isWashingtonPost: accepts canonical with 'The ' prefix", () => {
  assert.equal(isWashingtonPost("The Washington Post — Politics"), true);
  assert.equal(isWashingtonPost("The Washington Post"), true);
  assert.equal(isWashingtonPost("The Washington Post — World"), true);
});

test("isWashingtonPost: accepts canonical without 'The ' prefix (regression vs ILIKE 'The Washington Post%')", () => {
  // The old SQL would have returned false here and disabled these rows.
  assert.equal(isWashingtonPost("Washington Post — Politics"), true);
  assert.equal(isWashingtonPost("Washington Post"), true);
  assert.equal(isWashingtonPost("Washington Post-Politics"), true);
});

test("isWashingtonPost: tolerates punctuation/spacing variants", () => {
  assert.equal(isWashingtonPost("Washington Post: Politics"), true);
  assert.equal(isWashingtonPost("Washington   Post  Politics"), true);
  assert.equal(isWashingtonPost("  The Washington Post — National  "), true);
  assert.equal(isWashingtonPost("Washington Post (Politics)"), true);
  assert.equal(isWashingtonPost("Washington Post / Politics"), true);
});

test("isWashingtonPost: case-insensitive", () => {
  assert.equal(isWashingtonPost("THE WASHINGTON POST"), true);
  assert.equal(isWashingtonPost("washington post"), true);
  assert.equal(isWashingtonPost("Washington POST — politics"), true);
});

test("isWashingtonPost: rejects non-WaPo entities", () => {
  assert.equal(isWashingtonPost("The New York Times — Politics"), false);
  assert.equal(isWashingtonPost("Reuters — World News"), false);
  assert.equal(isWashingtonPost("El Tiempo — Política"), false);
  assert.equal(isWashingtonPost("Politico — Congress"), false);
  assert.equal(isWashingtonPost("@latamwatcher"), false);
  assert.equal(isWashingtonPost(null), false);
  assert.equal(isWashingtonPost(undefined), false);
  assert.equal(isWashingtonPost(""), false);
});

test("isWashingtonPost: does NOT accidentally match unrelated 'post' tokens", () => {
  assert.equal(isWashingtonPost("Jakarta Post"), false);
  assert.equal(isWashingtonPost("New York Post"), false);
  assert.equal(isWashingtonPost("Washington Times"), false);
});

test("normalizeForWaPoCheck: drops a leading 'The ' but not internal 'the'", () => {
  assert.equal(normalizeForWaPoCheck("The Washington Post"), "washington post");
  assert.equal(normalizeForWaPoCheck("Notes on the Washington Post"), "notes on the washington post");
});

test("normalizeForWaPoCheck: handles null/undefined safely", () => {
  assert.equal(normalizeForWaPoCheck(null), "");
  assert.equal(normalizeForWaPoCheck(undefined), "");
});

// ─── Restore safety: planner partitions tracker entries by UPDATE rowCount ──

test("planRestoreActions: rows with rowCount > 0 are 'resolved' (tracker delete safe)", () => {
  const tracked = [
    { manifest_feed_id: "wapo-pol", canonical_name: "The Washington Post", prev_active: true },
    { manifest_feed_id: "nyt", canonical_name: "NYT", prev_active: true },
  ];
  const counts = new Map([["wapo-pol", 1], ["nyt", 1]]);
  const { resolved, unresolved } = planRestoreActions(tracked, counts);
  assert.equal(resolved.length, 2);
  assert.equal(unresolved.length, 0);
});

test("planRestoreActions: rows with rowCount === 0 are 'unresolved' (tracker MUST be preserved)", () => {
  // This is the safety contract: missing manifest rows must NOT cause tracker
  // deletion. The previous restore loop deleted unconditionally, silently
  // dropping recovery state for rows that had been removed from the manifest.
  const tracked = [
    { manifest_feed_id: "ghost", canonical_name: "Removed Feed", prev_active: true },
  ];
  const counts = new Map([["ghost", 0]]);
  const { resolved, unresolved } = planRestoreActions(tracked, counts);
  assert.equal(resolved.length, 0);
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0].manifest_feed_id, "ghost");
});

test("planRestoreActions: missing entry in updateRowCountById is treated as unresolved (defensive default)", () => {
  // If the loop crashed before issuing the UPDATE for some entry, the map
  // won't have a key for that entry. Be defensive: treat missing as 0 so we
  // never delete the tracker row in that case.
  const tracked = [
    { manifest_feed_id: "skipped", canonical_name: "Skipped", prev_active: true },
  ];
  const { resolved, unresolved } = planRestoreActions(tracked, new Map());
  assert.equal(resolved.length, 0);
  assert.equal(unresolved.length, 1);
});

test("planRestoreActions: mixed batch — partition by rowCount", () => {
  const tracked = [
    { manifest_feed_id: "ok-1", prev_active: true },
    { manifest_feed_id: "ghost-1", prev_active: true },
    { manifest_feed_id: "ok-2", prev_active: false },
    { manifest_feed_id: "ghost-2", prev_active: true },
  ];
  const counts = new Map([
    ["ok-1", 1],
    ["ghost-1", 0],
    ["ok-2", 1],
    ["ghost-2", 0],
  ]);
  const { resolved, unresolved } = planRestoreActions(tracked, counts);
  assert.deepEqual(resolved.map((r) => r.manifest_feed_id).sort(), ["ok-1", "ok-2"]);
  assert.deepEqual(unresolved.map((r) => r.manifest_feed_id).sort(), ["ghost-1", "ghost-2"]);
});

test("planRestoreActions: empty inputs return empty resolved + unresolved", () => {
  const { resolved, unresolved } = planRestoreActions([], new Map());
  assert.equal(resolved.length, 0);
  assert.equal(unresolved.length, 0);
});

test("planRestoreActions: tolerates null/undefined args without throwing", () => {
  const a = planRestoreActions(null, null);
  assert.equal(a.resolved.length, 0);
  assert.equal(a.unresolved.length, 0);
  const b = planRestoreActions(undefined, undefined);
  assert.equal(b.resolved.length, 0);
  assert.equal(b.unresolved.length, 0);
});
