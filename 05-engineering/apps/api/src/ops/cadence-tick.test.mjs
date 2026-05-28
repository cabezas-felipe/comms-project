// Sub-slice 2.5: cadence-tick entrypoint contract tests.
//
// Exercises the structured-log shape + exit-code semantics defined in
// `cadence-tick.mjs`.  No server.mjs import, no Supabase — `runCadenceTick`
// is called directly with stubbed `runDueRefreshesFn`, `logger`, and
// `envGet` so each branch is reached deterministically.

import test from "node:test";
import assert from "node:assert/strict";

import { runCadenceTick } from "./cadence-tick.mjs";

function makeLogger() {
  const lines = [];
  return {
    log: (line) => lines.push(line),
    lines,
    /**
     * Parse the single `[cadence-tick] {…}` JSON payload from collected output.
     * Asserts there is exactly one such line so tests catch accidental
     * double-logging from any future refactor.
     */
    parseSummary() {
      const tagged = lines.filter((l) => l.startsWith("[cadence-tick] "));
      assert.equal(tagged.length, 1, "expected exactly one [cadence-tick] line");
      return JSON.parse(tagged[0].slice("[cadence-tick] ".length));
    },
  };
}

function makeEnv(overrides = {}) {
  const defaults = {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-stub",
  };
  const merged = { ...defaults, ...overrides };
  return (name) => merged[name];
}

// ─── Env preconditions ──────────────────────────────────────────────────────

test("runCadenceTick: missing SUPABASE_URL → exit 1, skippedReason=missing_supabase_env, runFn never invoked", async () => {
  const logger = makeLogger();
  let runFnCalls = 0;
  const result = await runCadenceTick({
    runDueRefreshesFn: async () => {
      runFnCalls += 1;
      return { skippedReason: "none", candidates: 0, due: 0, ran: 0, errors: 0, kinds: {} };
    },
    logger: logger.log,
    envGet: makeEnv({ SUPABASE_URL: undefined }),
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.reason, "missing_supabase_env");
  assert.equal(runFnCalls, 0, "runDueRefreshes must not be called when env is missing");
  const summary = logger.parseSummary();
  assert.equal(summary.ok, false);
  assert.equal(summary.skippedReason, "missing_supabase_env");
});

test("runCadenceTick: missing SUPABASE_SERVICE_ROLE_KEY → exit 1, skippedReason=missing_supabase_env", async () => {
  const logger = makeLogger();
  const result = await runCadenceTick({
    runDueRefreshesFn: async () => ({ skippedReason: "none" }),
    logger: logger.log,
    envGet: makeEnv({ SUPABASE_SERVICE_ROLE_KEY: "" }),
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.reason, "missing_supabase_env");
});

// ─── Successful tick (per-user errors do NOT fail the run) ──────────────────

test("runCadenceTick: skippedReason=none → exit 0, summary fields logged verbatim", async () => {
  const logger = makeLogger();
  const orchestratorSummary = {
    candidates: 3,
    due: 2,
    ran: 2,
    errors: 0,
    kinds: { ran: 1, unchanged: 1 },
    skippedReason: "none",
    intervalMs: 3_600_000,
    now: "2026-05-28T12:00:00.000Z",
  };
  const result = await runCadenceTick({
    runDueRefreshesFn: async () => orchestratorSummary,
    logger: logger.log,
    envGet: makeEnv(),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.reason, null);
  assert.equal(result.summary, orchestratorSummary);

  const summary = logger.parseSummary();
  assert.equal(summary.ok, true);
  assert.equal(summary.candidates, 3);
  assert.equal(summary.due, 2);
  assert.equal(summary.ran, 2);
  assert.equal(summary.errors, 0);
  assert.deepEqual(summary.kinds, { ran: 1, unchanged: 1 });
  assert.equal(summary.skippedReason, "none");
  assert.equal(summary.intervalMs, 3_600_000);
  assert.equal(typeof summary.startedAt, "string");
});

test("runCadenceTick: per-user errors counted in summary do NOT fail the run", async () => {
  // Contract from 2.4: one user's executor throw is counted in summary.errors
  // but does not abort the orchestrator loop.  The tick entrypoint must
  // mirror that — exit 0 so cron does not spin retries on a single bad user.
  const logger = makeLogger();
  const result = await runCadenceTick({
    runDueRefreshesFn: async () => ({
      candidates: 2,
      due: 2,
      ran: 1,
      errors: 1,
      kinds: { ran: 1 },
      skippedReason: "none",
      intervalMs: 3_600_000,
    }),
    logger: logger.log,
    envGet: makeEnv(),
  });
  assert.equal(result.exitCode, 0, "per-user error must not produce exit 1");
  const summary = logger.parseSummary();
  assert.equal(summary.ok, true);
  assert.equal(summary.errors, 1);
  assert.equal(summary.ran, 1);
});

// ─── Orchestrator-level failures → exit 1 ────────────────────────────────────

test("runCadenceTick: skippedReason=list_threw → exit 1, error surfaced in log", async () => {
  const logger = makeLogger();
  const result = await runCadenceTick({
    runDueRefreshesFn: async () => ({
      candidates: 0,
      due: 0,
      ran: 0,
      errors: 0,
      kinds: {},
      skippedReason: "list_threw",
      intervalMs: 3_600_000,
      error: "network unreachable",
    }),
    logger: logger.log,
    envGet: makeEnv(),
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.reason, "list_threw");
  const summary = logger.parseSummary();
  assert.equal(summary.ok, false);
  assert.equal(summary.skippedReason, "list_threw");
  assert.match(summary.error, /network unreachable/);
});

test("runCadenceTick: skippedReason=list_error → exit 1", async () => {
  const logger = makeLogger();
  const result = await runCadenceTick({
    runDueRefreshesFn: async () => ({
      candidates: 0,
      due: 0,
      ran: 0,
      errors: 0,
      kinds: {},
      skippedReason: "list_error",
      intervalMs: 3_600_000,
      error: "supabase down",
    }),
    logger: logger.log,
    envGet: makeEnv(),
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.reason, "list_error");
});

test("runCadenceTick: runDueRefreshes itself throws → exit 1, skippedReason=orchestrator_threw", async () => {
  const logger = makeLogger();
  const result = await runCadenceTick({
    runDueRefreshesFn: async () => {
      throw new Error("server boot exploded");
    },
    logger: logger.log,
    envGet: makeEnv(),
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.reason, "orchestrator_threw");
  const summary = logger.parseSummary();
  assert.equal(summary.ok, false);
  assert.equal(summary.skippedReason, "orchestrator_threw");
  assert.match(summary.error, /server boot exploded/);
});

// ─── Log shape stability ─────────────────────────────────────────────────────

test("runCadenceTick: log line is a single JSON object prefixed with [cadence-tick]", async () => {
  // Ops contract: cron output is grepped via `[cadence-tick]`; the payload
  // must be one parseable JSON object on one line so log shippers can
  // forward it without multi-line stitching.
  const logger = makeLogger();
  await runCadenceTick({
    runDueRefreshesFn: async () => ({
      candidates: 0,
      due: 0,
      ran: 0,
      errors: 0,
      kinds: {},
      skippedReason: "none",
      intervalMs: 3_600_000,
    }),
    logger: logger.log,
    envGet: makeEnv(),
  });
  assert.equal(logger.lines.length, 1, "no extra log lines from a clean tick");
  const line = logger.lines[0];
  assert.ok(line.startsWith("[cadence-tick] "), "line must start with the tag");
  assert.doesNotThrow(
    () => JSON.parse(line.slice("[cadence-tick] ".length)),
    "payload must be valid JSON"
  );
});
