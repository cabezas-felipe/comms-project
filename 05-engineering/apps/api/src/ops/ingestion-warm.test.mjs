// Phase 1 Slice 3: ingestion-warm entrypoint contract tests.
//
// Exercises the structured-log shape + exit-code semantics defined in
// `ingestion-warm.mjs`.  No server.mjs import, no Supabase, no real RSS —
// `runIngestionWarm` is called directly with stubbed `readFeedItemsFn`,
// `writeRecentItemsFn`, `supabase`, `logger`, and `envGet` so each branch is
// reached deterministically.

import test from "node:test";
import assert from "node:assert/strict";

import { runIngestionWarm } from "./ingestion-warm.mjs";

function makeLogger() {
  const lines = [];
  return {
    log: (line) => lines.push(line),
    lines,
    /**
     * Parse the single `[ingestion-warm] {…}` JSON payload from collected
     * output.  Asserts exactly one such line so tests catch accidental
     * double-logging from any future refactor.
     */
    parseSummary() {
      const tagged = lines.filter((l) => l.startsWith("[ingestion-warm] "));
      assert.equal(tagged.length, 1, "expected exactly one [ingestion-warm] line");
      return JSON.parse(tagged[0].slice("[ingestion-warm] ".length));
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

// Two raw items spanning two distinct feeds so feedCount is exercised too.
const TWO_RAW_ITEMS = [
  { sourceId: "reuters-world::a", feedId: "reuters-world", outlet: "Reuters", url: "https://r/a", headline: "A", body: ["a"], minutesAgo: 5, weight: 80 },
  { sourceId: "wapo-pol::b", feedId: "wapo-pol", outlet: "The Washington Post", url: "https://w/b", headline: "B", body: ["b"], minutesAgo: 9, weight: 95 },
];

// ─── Env preconditions ──────────────────────────────────────────────────────

test("runIngestionWarm: missing SUPABASE_URL → exit 1, skippedReason=missing_supabase_env, read/write never invoked", async () => {
  const logger = makeLogger();
  let readCalls = 0;
  let writeCalls = 0;
  const result = await runIngestionWarm({
    readFeedItemsFn: async () => { readCalls += 1; return TWO_RAW_ITEMS; },
    writeRecentItemsFn: async () => { writeCalls += 1; return { written: 2, error: null }; },
    logger: logger.log,
    envGet: makeEnv({ SUPABASE_URL: undefined }),
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.reason, "missing_supabase_env");
  assert.equal(readCalls, 0, "live read must not run when env is missing");
  assert.equal(writeCalls, 0, "cache write must not run when env is missing");
  const summary = logger.parseSummary();
  assert.equal(summary.ok, false);
  assert.equal(summary.skippedReason, "missing_supabase_env");
});

test("runIngestionWarm: missing SUPABASE_SERVICE_ROLE_KEY → exit 1, skippedReason=missing_supabase_env", async () => {
  const logger = makeLogger();
  const result = await runIngestionWarm({
    readFeedItemsFn: async () => TWO_RAW_ITEMS,
    writeRecentItemsFn: async () => ({ written: 2, error: null }),
    logger: logger.log,
    envGet: makeEnv({ SUPABASE_SERVICE_ROLE_KEY: "" }),
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.reason, "missing_supabase_env");
});

// ─── Happy path: full-manifest warm ──────────────────────────────────────────

test("runIngestionWarm: fetches full manifest (no feedIds) and writes the fetched items", async () => {
  const logger = makeLogger();
  const supabaseStub = { tag: "injected-client" };
  let readArgs = null;
  let writeArgs = null;
  const result = await runIngestionWarm({
    readFeedItemsFn: async (...args) => { readArgs = args; return TWO_RAW_ITEMS; },
    writeRecentItemsFn: async (opts) => { writeArgs = opts; return { written: opts.items.length, error: null }; },
    supabase: supabaseStub,
    dataDir: "/warm/data",
    logger: logger.log,
    envGet: makeEnv(),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.reason, null);

  // Full-manifest warm contract: readFeedItems is called with the dataDir and
  // NO second arg — the warmer must never scope by feedIds.
  assert.deepEqual(readArgs, ["/warm/data"], "readFeedItems must be called with dataDir only (no feedIds opts)");
  assert.equal(readArgs.length, 1, "no second (opts) arg may be passed — full manifest warm");

  // The write must receive the exact items the reader produced + the injected
  // client.
  assert.ok(writeArgs, "writeRecentItems must be called");
  assert.equal(writeArgs.supabase, supabaseStub, "write must use the injected supabase client");
  assert.deepEqual(writeArgs.items, TWO_RAW_ITEMS, "write must receive the fetched raw items verbatim");

  const summary = logger.parseSummary();
  assert.equal(summary.ok, true);
  assert.equal(summary.itemCount, 2);
  assert.equal(summary.feedCount, 2, "two distinct feedIds");
  assert.equal(summary.written, 2);
  assert.equal(typeof summary.startedAt, "string");
  assert.equal(typeof summary.durationMs, "number");
});

test("runIngestionWarm: empty manifest is a clean success (exit 0, written 0)", async () => {
  const logger = makeLogger();
  const result = await runIngestionWarm({
    readFeedItemsFn: async () => [],
    writeRecentItemsFn: async ({ items }) => ({ written: items.length, error: null }),
    supabase: {},
    logger: logger.log,
    envGet: makeEnv(),
  });
  assert.equal(result.exitCode, 0, "an empty manifest is not a failure");
  const summary = logger.parseSummary();
  assert.equal(summary.ok, true);
  assert.equal(summary.itemCount, 0);
  assert.equal(summary.feedCount, 0);
  assert.equal(summary.written, 0);
});

// ─── Fatal read / write failures → exit 1 ────────────────────────────────────

test("runIngestionWarm: live read throws → exit 1, skippedReason=read_threw, write never runs", async () => {
  const logger = makeLogger();
  let writeCalls = 0;
  const result = await runIngestionWarm({
    readFeedItemsFn: async () => { throw new Error("RSS endpoint unreachable"); },
    writeRecentItemsFn: async () => { writeCalls += 1; return { written: 0, error: null }; },
    supabase: {},
    logger: logger.log,
    envGet: makeEnv(),
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.reason, "read_threw");
  assert.equal(writeCalls, 0, "write must not run when the read threw");
  const summary = logger.parseSummary();
  assert.equal(summary.ok, false);
  assert.equal(summary.skippedReason, "read_threw");
  assert.match(summary.error, /RSS endpoint unreachable/);
});

test("runIngestionWarm: write returns an error envelope → exit 1, skippedReason=write_error", async () => {
  const logger = makeLogger();
  const result = await runIngestionWarm({
    readFeedItemsFn: async () => TWO_RAW_ITEMS,
    writeRecentItemsFn: async () => ({ written: 0, error: new Error("upsert rejected") }),
    supabase: {},
    logger: logger.log,
    envGet: makeEnv(),
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.reason, "write_error");
  const summary = logger.parseSummary();
  assert.equal(summary.ok, false);
  assert.equal(summary.skippedReason, "write_error");
  assert.match(summary.error, /upsert rejected/);
  assert.equal(summary.itemCount, 2, "item/feed counts still reported on a write error");
});

test("runIngestionWarm: write throws → exit 1, skippedReason=write_threw", async () => {
  const logger = makeLogger();
  const result = await runIngestionWarm({
    readFeedItemsFn: async () => TWO_RAW_ITEMS,
    writeRecentItemsFn: async () => { throw new Error("connection reset"); },
    supabase: {},
    logger: logger.log,
    envGet: makeEnv(),
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.reason, "write_threw");
  const summary = logger.parseSummary();
  assert.equal(summary.ok, false);
  assert.equal(summary.skippedReason, "write_threw");
  assert.match(summary.error, /connection reset/);
});

// ─── Log shape stability ─────────────────────────────────────────────────────

test("runIngestionWarm: log line is a single JSON object prefixed with [ingestion-warm]", async () => {
  // Ops contract: cron output is grepped via `[ingestion-warm]`; the payload
  // must be one parseable JSON object on one line so log shippers can forward
  // it without multi-line stitching.
  const logger = makeLogger();
  await runIngestionWarm({
    readFeedItemsFn: async () => TWO_RAW_ITEMS,
    writeRecentItemsFn: async ({ items }) => ({ written: items.length, error: null }),
    supabase: {},
    logger: logger.log,
    envGet: makeEnv(),
  });
  assert.equal(logger.lines.length, 1, "no extra log lines from a clean warm");
  const line = logger.lines[0];
  assert.ok(line.startsWith("[ingestion-warm] "), "line must start with the tag");
  assert.doesNotThrow(
    () => JSON.parse(line.slice("[ingestion-warm] ".length)),
    "payload must be valid JSON"
  );
});
