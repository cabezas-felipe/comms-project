import { test } from "node:test";
import assert from "node:assert/strict";

// Importing the script must not connect to anything (the entry-point guard keeps
// dotenv / Supabase out of the import path). These tests cover only the pure
// helpers: arg parsing, redaction, the pass/fail summary, and report formatting.
const { parseArgs, usage, redactSample, summarize, formatReport, BASE_TABLES, SESSION_TABLE } =
  await import("./e2e-assert-clean.mjs");

// ─── parseArgs ───────────────────────────────────────────────────────────────

test("parseArgs: requires --user-id", () => {
  const r = parseArgs([]);
  assert.equal(r.ok, false);
  assert.match(r.error, /--user-id/);
});

test("parseArgs: backward compatible — only --user-id", () => {
  const r = parseArgs(["--user-id", "u1"]);
  assert.equal(r.ok, true);
  assert.equal(r.userId, "u1");
  assert.equal(r.requireNoSessions, false);
});

test("parseArgs: --require-no-sessions toggles the flag", () => {
  const r = parseArgs(["--user-id", "u1", "--require-no-sessions"]);
  assert.equal(r.ok, true);
  assert.equal(r.requireNoSessions, true);
});

test("parseArgs: rejects unknown argument", () => {
  const r = parseArgs(["--user-id", "u1", "--nope"]);
  assert.equal(r.ok, false);
  assert.match(r.error, /Unknown argument: --nope/);
});

// ─── usage ───────────────────────────────────────────────────────────────────

test("usage: documents the new flag", () => {
  assert.match(usage(), /--require-no-sessions/);
  assert.match(usage(), /--user-id/);
});

// ─── redactSample ────────────────────────────────────────────────────────────

test("redactSample: omits object/array payload columns", () => {
  const out = redactSample({ user_id: "u1", payload: { huge: "x" }, items: [1, 2, 3] });
  assert.equal(out.user_id, "u1");
  assert.equal(out.payload, "[omitted]");
  assert.equal(out.items, "[omitted]");
});

test("redactSample: truncates long strings, preserves short scalars + timestamps", () => {
  const long = "a".repeat(500);
  const out = redactSample({ key: "user:u1", updated_at: "2026-06-09T00:00:00Z", reason_code: long });
  assert.equal(out.key, "user:u1");
  assert.equal(out.updated_at, "2026-06-09T00:00:00Z");
  assert.ok(out.reason_code.length < long.length);
  assert.match(out.reason_code, /…$/);
});

test("redactSample: keeps null/undefined as-is", () => {
  const out = redactSample({ meta_story_id: null });
  assert.equal(out.meta_story_id, null);
});

// ─── summarize ───────────────────────────────────────────────────────────────

test("summarize: all zero counts → pass", () => {
  const r = summarize([
    { table: "dashboard_snapshots", count: 0, samples: [], error: null },
    { table: "settings", count: 0, samples: [], error: null },
  ]);
  assert.equal(r.pass, true);
  assert.equal(r.dirty.length, 0);
  assert.equal(r.errored.length, 0);
});

test("summarize: any non-zero count → fail (dirty)", () => {
  const r = summarize([
    { table: "dashboard_snapshots", count: 0, samples: [], error: null },
    { table: "settings", count: 2, samples: [], error: null },
  ]);
  assert.equal(r.pass, false);
  assert.deepEqual(r.dirty.map((d) => d.table), ["settings"]);
});

test("summarize: a query error fails the run even at zero count", () => {
  const r = summarize([
    { table: "auth.sessions", count: null, samples: [], error: "count failed: boom" },
  ]);
  assert.equal(r.pass, false);
  assert.deepEqual(r.errored.map((e) => e.table), ["auth.sessions"]);
});

// ─── formatReport ────────────────────────────────────────────────────────────

test("formatReport: PASS is a single concise line", () => {
  const out = formatReport({
    userId: "u1",
    results: [{ table: "settings", count: 0, samples: [], error: null }],
  });
  assert.match(out, /^\[e2e:assert-clean\] PASS user_id=u1/);
  assert.match(out, /baseline clean/);
});

test("formatReport: FAIL shows per-table counts, samples, and dirty list", () => {
  const out = formatReport({
    userId: "u1",
    results: [
      { table: "dashboard_snapshots", count: 0, samples: [], error: null },
      {
        table: "settings",
        count: 1,
        samples: [{ key: "user:u1", updated_at: "2026-06-09T00:00:00Z" }],
        error: null,
      },
    ],
  });
  assert.match(out, /FAIL user_id=u1/);
  assert.match(out, /settings: 1 row\(s\)/);
  assert.match(out, /"key":"user:u1"/);
  assert.match(out, /dirty_tables=\[settings\]/);
  // clean table is not listed in the breakdown
  assert.doesNotMatch(out, /dashboard_snapshots: \d/);
});

test("formatReport: FAIL surfaces query errors explicitly and names errored tables", () => {
  const out = formatReport({
    userId: "u1",
    results: [{ table: "auth.sessions", count: null, samples: [], error: "count failed: denied" }],
  });
  assert.match(out, /auth\.sessions: QUERY ERROR — count failed: denied/);
  assert.match(out, /errored_tables=\[auth\.sessions\]/);
});

test("formatReport: notes truncation when count exceeds shown samples", () => {
  const out = formatReport({
    userId: "u1",
    results: [
      {
        table: "story_rejections",
        count: 7,
        samples: [{ id: 1 }, { id: 2 }, { id: 3 }],
        error: null,
      },
    ],
  });
  assert.match(out, /story_rejections: 7 row\(s\)/);
  assert.match(out, /\+4 more \(showing first 3\)/);
});

// ─── specs ───────────────────────────────────────────────────────────────────

test("BASE_TABLES: covers the six baseline tables; settings uses key_like", () => {
  const names = BASE_TABLES.map((t) => t.table);
  assert.deepEqual(new Set(names), new Set([
    "dashboard_snapshots",
    "meta_story_locks",
    "story_rejections",
    "geo_hold_bucket",
    "user_onboarding_narratives",
    "settings",
  ]));
  assert.equal(BASE_TABLES.find((t) => t.table === "settings").filter, "key_like");
  // No base spec selects a large JSONB payload column.
  const banned = new Set(["payload", "items", "data", "debug_payload", "raw_text", "source_item_ids"]);
  for (const t of BASE_TABLES) {
    for (const col of t.select) assert.ok(!banned.has(col), `${t.table} selects payload col ${col}`);
  }
});

test("SESSION_TABLE: targets auth.sessions schema", () => {
  assert.equal(SESSION_TABLE.schema, "auth");
  assert.equal(SESSION_TABLE.table, "sessions");
  assert.equal(SESSION_TABLE.label, "auth.sessions");
});
