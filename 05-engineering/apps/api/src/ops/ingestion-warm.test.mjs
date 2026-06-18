// Phase 1 Slice 3: ingestion-warm entrypoint contract tests.
//
// Exercises the structured-log shape + exit-code semantics defined in
// `ingestion-warm.mjs`.  No server.mjs import, no Supabase, no real RSS —
// `runIngestionWarm` is called directly with stubbed `readFeedItemsFn`,
// `writeRecentItemsFn`, `supabase`, `logger`, and `envGet` so each branch is
// reached deterministically.

import test from "node:test";
import assert from "node:assert/strict";

import { runIngestionWarm, normalizeErrorDetail } from "./ingestion-warm.mjs";

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

// ─── Actionable error serialization (object-like supabase errors) ────────────

test("runIngestionWarm: write error envelope with a PostgREST object → serialized, actionable (never [object Object])", async () => {
  // The regression we're guarding: writeRecentItems returns the raw supabase
  // error object (a plain { message, code, details, hint }, NOT an Error). The
  // old String(err) rendered it as "[object Object]", which is what made the
  // scheduled warmer failures impossible to diagnose from the log.
  const pgError = {
    message: "permission denied for table ingestion_recent_items",
    code: "42501",
    details: "service role lacks INSERT",
    hint: "grant insert on ingestion_recent_items",
  };
  const logger = makeLogger();
  const result = await runIngestionWarm({
    readFeedItemsFn: async () => TWO_RAW_ITEMS,
    writeRecentItemsFn: async () => ({ written: 0, error: pgError }),
    supabase: {},
    logger: logger.log,
    envGet: makeEnv(),
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.reason, "write_error");
  const summary = logger.parseSummary();
  assert.equal(summary.ok, false);
  assert.equal(summary.skippedReason, "write_error");
  // error must be a string and must NOT be the opaque object marker.
  assert.equal(typeof summary.error, "string");
  assert.doesNotMatch(summary.error, /\[object Object\]/, "must not render as [object Object]");
  // All actionable fields survive into the log line.
  assert.match(summary.error, /permission denied for table ingestion_recent_items/);
  assert.match(summary.error, /42501/);
  assert.match(summary.error, /service role lacks INSERT/);
  assert.match(summary.error, /grant insert on ingestion_recent_items/);
  // Counts still reported on a write error.
  assert.equal(summary.itemCount, 2);
  assert.equal(summary.feedCount, 2);
  assert.equal(summary.written, 0);
});

test("runIngestionWarm: write throws a non-Error object → exit 1, write_threw, serialized details", async () => {
  const logger = makeLogger();
  const result = await runIngestionWarm({
    readFeedItemsFn: async () => TWO_RAW_ITEMS,
    writeRecentItemsFn: async () => { throw { message: "socket hang up", code: "ECONNRESET" }; },
    supabase: {},
    logger: logger.log,
    envGet: makeEnv(),
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.reason, "write_threw");
  const summary = logger.parseSummary();
  assert.equal(summary.skippedReason, "write_threw");
  assert.equal(typeof summary.error, "string");
  assert.doesNotMatch(summary.error, /\[object Object\]/);
  assert.match(summary.error, /socket hang up/);
  assert.match(summary.error, /ECONNRESET/);
});

test("normalizeErrorDetail: covers string / Error / PostgREST object / fallback / nullish", () => {
  // string → itself
  assert.equal(normalizeErrorDetail("plain string"), "plain string");

  // Error → message (kept greppable for the existing assert.match contracts)
  assert.match(normalizeErrorDetail(new Error("upsert rejected")), /upsert rejected/);

  // PostgREST object → compact JSON preserving message/code/details/hint
  const serialized = normalizeErrorDetail({
    message: "undefined table",
    code: "42P01",
    details: null, // null fields are dropped, not rendered as "null"
    hint: "run migrations",
  });
  assert.doesNotMatch(serialized, /\[object Object\]/);
  const parsed = JSON.parse(serialized);
  assert.equal(parsed.message, "undefined table");
  assert.equal(parsed.code, "42P01");
  assert.equal(parsed.hint, "run migrations");
  assert.equal("details" in parsed, false, "null fields are omitted");

  // status/statusCode (transport-level) are preserved when present
  assert.match(normalizeErrorDetail({ message: "Bad Gateway", status: 502 }), /502/);

  // nullish → undefined (so the field is simply absent from the payload)
  assert.equal(normalizeErrorDetail(null), undefined);
  assert.equal(normalizeErrorDetail(undefined), undefined);

  // pathological empty object → labelled fallback, never "[object Object]"
  assert.doesNotMatch(normalizeErrorDetail({}), /\[object Object\]/);
});

// ─── X (social) warm (Phase 3, Step 3.1) ────────────────────────────────────
//
// After the RSS full-manifest warm, the warmer optionally warms a configured
// list of X handles into the same Tier-A cache.  Gated on the X feature being
// enabled (resolveXConfigFn().enabled) AND a non-empty TEMPO_X_WARM_HANDLES
// list.  Failures once X warm is attempted are fatal (exit 1) like the RSS
// write path; skipping X warm when unconfigured stays a clean success.  Both
// the reader and config resolver are injected so these stay hermetic.

const X_RAW_ITEMS = [
  { sourceId: "x:petrogustavo:aa", feedId: "x:petrogustavo", outlet: "@petrogustavo", kind: "social", weight: 60, url: "https://x.com/petrogustavo/status/1", headline: "uno", body: ["uno"], minutesAgo: 3 },
  { sourceId: "x:whitehouse:bb", feedId: "x:whitehouse", outlet: "@whitehouse", kind: "social", weight: 60, url: "https://x.com/whitehouse/status/2", headline: "two", body: ["two"], minutesAgo: 7 },
];

test("runIngestionWarm: X warm invoked when enabled + TEMPO_X_WARM_HANDLES set → handles fetched, items written", async () => {
  const logger = makeLogger();
  const writeBatches = [];
  let xReadArgs = null;
  const result = await runIngestionWarm({
    readFeedItemsFn: async () => TWO_RAW_ITEMS,
    writeRecentItemsFn: async ({ items }) => { writeBatches.push(items); return { written: items.length, error: null }; },
    readXItemsFn: async (args) => { xReadArgs = args; return { items: X_RAW_ITEMS, diagnostics: {} }; },
    resolveXConfigFn: () => ({ enabled: true, bearerToken: "secret-bearer", allowlist: [] }),
    supabase: {},
    logger: logger.log,
    envGet: makeEnv({ TEMPO_X_WARM_HANDLES: "@PetroGustavo, whitehouse" }),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.reason, null);

  // Reader received the parsed, normalized warm handles + the resolved config.
  assert.ok(xReadArgs, "X reader must be invoked");
  assert.deepEqual(xReadArgs.socialSources, ["petrogustavo", "whitehouse"], "warm handles parsed like the allowlist");
  assert.equal(xReadArgs.config?.enabled, true, "reader receives the enabled X config");

  // Two write batches: RSS first, then the X items.
  assert.equal(writeBatches.length, 2, "RSS write then X write");
  assert.deepEqual(writeBatches[1], X_RAW_ITEMS, "second write carries the X items verbatim");

  const summary = logger.parseSummary();
  assert.equal(summary.ok, true);
  assert.equal(summary.xEnabled, true);
  assert.equal(summary.xHandlesWarmed, 2);
  assert.equal(summary.xItemCount, 2);
  assert.equal(summary.xWritten, 2);
  // RSS fields still present and unchanged.
  assert.equal(summary.itemCount, 2);
  assert.equal(summary.written, 2);
  // bearer token must never leak into the log line.
  assert.doesNotMatch(logger.lines[0], /secret-bearer/);
});

test("runIngestionWarm: X warm skipped when TEMPO_X_WARM_HANDLES unset → RSS-only success, reader never called", async () => {
  const logger = makeLogger();
  let xReadCalls = 0;
  const result = await runIngestionWarm({
    readFeedItemsFn: async () => TWO_RAW_ITEMS,
    writeRecentItemsFn: async ({ items }) => ({ written: items.length, error: null }),
    readXItemsFn: async () => { xReadCalls += 1; return { items: X_RAW_ITEMS, diagnostics: {} }; },
    resolveXConfigFn: () => ({ enabled: true, bearerToken: "secret-bearer", allowlist: [] }),
    supabase: {},
    logger: logger.log,
    envGet: makeEnv({ TEMPO_X_WARM_HANDLES: undefined }),
  });

  assert.equal(result.exitCode, 0, "no warm handles → clean RSS-only success");
  assert.equal(xReadCalls, 0, "X reader must not be called when the warm list is empty");
  const summary = logger.parseSummary();
  assert.equal(summary.ok, true);
  assert.equal(summary.xEnabled, true, "feature enabled, just no handles to warm");
  assert.equal(summary.xHandlesWarmed, 0);
  assert.equal(summary.xItemCount, 0);
  assert.equal(summary.xWritten, 0);
});

test("runIngestionWarm: X warm skipped when feature disabled, even if TEMPO_X_WARM_HANDLES set", async () => {
  const logger = makeLogger();
  let xReadCalls = 0;
  const result = await runIngestionWarm({
    readFeedItemsFn: async () => TWO_RAW_ITEMS,
    writeRecentItemsFn: async ({ items }) => ({ written: items.length, error: null }),
    readXItemsFn: async () => { xReadCalls += 1; return { items: X_RAW_ITEMS, diagnostics: {} }; },
    resolveXConfigFn: () => ({ enabled: false, bearerToken: "", allowlist: [] }),
    supabase: {},
    logger: logger.log,
    envGet: makeEnv({ TEMPO_X_WARM_HANDLES: "petrogustavo" }),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(xReadCalls, 0, "disabled feature → reader never called");
  const summary = logger.parseSummary();
  assert.equal(summary.ok, true);
  assert.equal(summary.xEnabled, false);
  assert.equal(summary.xHandlesWarmed, 0);
});

test("runIngestionWarm: X read throws → exit 1, skippedReason=x_read_threw, RSS write already happened", async () => {
  const logger = makeLogger();
  let writeCalls = 0;
  const result = await runIngestionWarm({
    readFeedItemsFn: async () => TWO_RAW_ITEMS,
    writeRecentItemsFn: async ({ items }) => { writeCalls += 1; return { written: items.length, error: null }; },
    readXItemsFn: async () => { throw new Error("X timeline 503"); },
    resolveXConfigFn: () => ({ enabled: true, bearerToken: "secret-bearer", allowlist: [] }),
    supabase: {},
    logger: logger.log,
    envGet: makeEnv({ TEMPO_X_WARM_HANDLES: "petrogustavo" }),
  });

  assert.equal(result.exitCode, 1, "X warm failure once attempted is fatal");
  assert.equal(result.reason, "x_read_threw");
  assert.equal(writeCalls, 1, "RSS write ran before the X read failed");
  const summary = logger.parseSummary();
  assert.equal(summary.ok, false);
  assert.equal(summary.skippedReason, "x_read_threw");
  assert.match(summary.error, /X timeline 503/);
});

test("runIngestionWarm: X write returns an error envelope → exit 1, skippedReason=x_write_error", async () => {
  const logger = makeLogger();
  const result = await runIngestionWarm({
    readFeedItemsFn: async () => TWO_RAW_ITEMS,
    // RSS write succeeds; the X write (second call) returns an error envelope.
    writeRecentItemsFn: async ({ items }) =>
      items === X_RAW_ITEMS ? { written: 0, error: new Error("x upsert rejected") } : { written: items.length, error: null },
    readXItemsFn: async () => ({ items: X_RAW_ITEMS, diagnostics: {} }),
    resolveXConfigFn: () => ({ enabled: true, bearerToken: "secret-bearer", allowlist: [] }),
    supabase: {},
    logger: logger.log,
    envGet: makeEnv({ TEMPO_X_WARM_HANDLES: "petrogustavo, whitehouse" }),
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.reason, "x_write_error");
  const summary = logger.parseSummary();
  assert.equal(summary.ok, false);
  assert.equal(summary.skippedReason, "x_write_error");
  assert.match(summary.error, /x upsert rejected/);
  assert.equal(summary.xHandlesWarmed, 2, "warm-handle count still reported on a write error");
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
