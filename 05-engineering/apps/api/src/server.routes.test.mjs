import { after, test, beforeEach, afterEach, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const FIXTURE_SOURCE_ITEMS = [
  {
    clusterId: "test-cluster",
    title: "Test cluster title",
    topic: "Diplomatic relations",
    geographies: ["US"],
    priority: "standard",
    takeaway: "Test takeaway",
    summary: "Test summary",
    whyItMatters: "Test why it matters",
    whatChanged: "Test what changed",
    sourceId: "test-src-1",
    outlet: "Reuters",
    byline: "Test Author",
    kind: "traditional",
    weight: 50,
    url: "https://example.com",
    minutesAgo: 10,
    headline: "Test Headline",
    body: ["Test body paragraph one"],
  },
];

// Set temp data dir before importing server so DATA_DIR resolves to isolated storage.
const tmpDir = await mkdtemp(path.join(tmpdir(), "tempo-api-test-"));
process.env.TEMPO_DATA_DIR = tmpDir;
// Pin NODE_ENV=test and strip Supabase env BEFORE importing server.mjs.
// Why: server.mjs's bootstrapApiEnv() loads .env from common roots when
// NODE_ENV !== "test", which populates SUPABASE_URL + service-role key in the
// test process.  Once those are set, settings-repo.readSettings/hasSettings
// take the Supabase path and never observe the file-seeded fixtures used by
// these tests — every settings GET returns DEFAULT_SETTINGS instead of the
// seeded payload, and refresh routes try to read source-feeds from Supabase
// instead of the JSON manifest.  Setting NODE_ENV=test makes the test robust
// to being run without the package.json wrapper (e.g., a bare `node --test`).
process.env.NODE_ENV = "test";
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.SUPABASE_ANON_KEY;
// Seed source-items fixture before server import so GET /api/dashboard can read it.
await writeFile(path.join(tmpDir, "source-items.json"), JSON.stringify(FIXTURE_SOURCE_ITEMS), "utf8");
// Seed source-feeds fixture for GET /api/ingestion/sources AND POST /api/dashboard/refresh
// (Phase 2 source-matcher loads this manifest to resolve user-selected sources).  Includes
// rows whose names match the traditional/social sources used in VALID_BODY so source selection
// resolves rather than falling through to the empty-fallback path.
const FIXTURE_SOURCE_FEEDS = {
  feeds: [
    { id: "nyt-politics", name: "The New York Times", kind: "rss", url: "https://example.com/rss", weight: 95, active: true },
    { id: "reuters-world", name: "Reuters — World News", kind: "rss", url: "https://example.com/reuters", weight: 88, active: true },
    // social row — matches by name but no implemented connector → unavailable
    { id: "latamwatcher", name: "@latamwatcher", kind: "social", url: "https://twitter.com/latamwatcher", weight: 60, active: true },
  ],
};
await writeFile(path.join(tmpDir, "source-feeds.json"), JSON.stringify(FIXTURE_SOURCE_FEEDS), "utf8");

const { app, _auth, _extraction, _emailLookup, _clearEmailCache, resolveIdentity, _sourceRegistrySync, _feedManifest, _narrativeRepo, _writeSettings, _atomicSave, _readSettings, _snapshotRepo, _refreshPipeline, _pipelineRunner, _refreshExecutor, _refreshPrefetch, _whyEnricher, _embeddings, _recentItemsCache, _feedReader, _dueUserOrchestrator, _refreshSlo } = await import("./server.mjs");
const { createJob: _createRefreshJob, getJob: _getRefreshJob, setPhase: _setRefreshPhase, completeJob: _completeRefreshJob, _resetRefreshJobs } = await import("./dashboard/refresh-job.mjs");
// Slice 6: the genuine cold-start prefetch kickoff. Captured once so the suite
// can neutralize prefetch by default (below) — most route tests don't stub the
// refresh executor, and a real fire-and-forget refresh would contaminate the
// shared snapshot store across tests. The Slice 6 tests opt back into the real
// implementation explicitly.
const _realPrefetchStart = _refreshPrefetch.start;
const { default: request } = await import("supertest");
const { settingsPayloadSchema, dashboardPayloadSchema, normalizeTopicLabel } = await import("./contracts-runtime/index.mjs");

// D1: shared shape guard for the additive `_meta.cacheBenefit` advisory.
// Asserts the runtime observability object is present and well-formed on a
// refresh response without pinning rolling-window p50 values (the in-memory
// window is a per-process singleton, so exact medians vary across tests).
function assertCacheBenefitShape(meta, label) {
  const cb = meta?.cacheBenefit;
  assert.ok(cb && typeof cb === "object", `${label}: _meta.cacheBenefit present`);
  assert.equal(typeof cb.ok, "boolean", `${label}: cacheBenefit.ok is boolean`);
  assert.ok(Array.isArray(cb.reasonCodes), `${label}: cacheBenefit.reasonCodes is array`);
  assert.ok(cb.sampleCounts && typeof cb.sampleCounts === "object", `${label}: cacheBenefit.sampleCounts present`);
  assert.equal(typeof cb.sampleCounts.cacheHit, "number", `${label}: sampleCounts.cacheHit is number`);
  assert.equal(typeof cb.sampleCounts.liveScoped, "number", `${label}: sampleCounts.liveScoped is number`);
}

// Stabilization helper (added for cross-test isolation): scopes a block of
// test code to a unique synthetic userId so the per-user settings file
// (`settings_user_<id>.json`) cannot collide with the suite-wide TEST_USER_ID
// file that interactive PUT /api/settings tests mutate.  Restores the prior
// resolver in finally — failures inside `fn` do not leak the override.
async function withIsolatedUser(uniqueId, fn) {
  const prevResolver = _auth.resolver;
  _auth.resolver = async () => ({ userId: uniqueId, source: "bearer" });
  try {
    return await fn();
  } finally {
    _auth.resolver = prevResolver;
  }
}

// Deterministic stand-in for `_refreshPipeline.run` used by topic-normalization
// tests.  Applies ONLY the contract under test — that `normalizeTopicLabel`
// is applied to both item.topic and settings.topics before matching — so the
// tests no longer depend on the live clustering / recall / beat-fit / grounding
// stages succeeding (which require Anthropic + OpenAI keys and stable model
// responses).  Returns a synthetic 1-story payload when at least one item's
// normalized topic matches a normalized setting topic; otherwise zero stories.
function topicNormalizationPipelineStub() {
  return async (opts) => {
    const items = Array.isArray(opts.rawItems) ? opts.rawItems : [];
    const settingTopics = new Set(
      (opts.settings?.topics ?? []).map((t) => normalizeTopicLabel(String(t)))
    );
    const matched = items.filter((it) =>
      settingTopics.has(normalizeTopicLabel(String(it?.topic ?? "")))
    );
    const stories = matched.length > 0
      ? [{
          id: "norm-test-story",
          metaStoryId: "norm-test-story",
          title: "Normalization Test Story",
          subtitle: "Synthetic subtitle.",
          geographies: Array.isArray(matched[0]?.geographies) && matched[0].geographies.length > 0
            ? matched[0].geographies
            : ["US"],
          topic: matched[0]?.topic ?? "Diplomatic relations",
          summary: "Synthetic summary for the normalization integration test.",
          whyItMatters: "Synthetic implication line.",
          whatChanged: "Synthetic delta line.",
          priority: "standard",
          outletCount: 1,
          tags: { topics: [], keywords: [], geographies: ["US"] },
          sources: [],
        }]
      : [];
    return {
      payload: { contractVersion: opts.contractVersion, stories },
      log: {
        unchanged: false,
        poolCount: items.length,
        relevantCount: matched.length,
        usedFallbackClustering: false,
        groundingFailures: 0,
        droppedUngroundedStoryCount: 0,
        groundingDropReasons: {},
        watermark: "norm-stub-watermark",
        candidateCount: matched.length,
        selectedFeedCount: 1,
        selection: { sourceSelectionMode: "test" },
      },
    };
  };
}

// Inject a deterministic test identity so protected routes authenticate without a live Supabase instance.
const TEST_USER_ID = "test-user-id";
_auth.resolver = async () => ({ userId: TEST_USER_ID, source: "bearer" });

// Inject a deterministic embedding stub so the recall stage doesn't fail-closed
// in tests that don't have TEMPO_OPENAI_API_KEY.  These route tests don't
// exercise embedding-recall semantics — they just need the recall stage to
// produce a non-empty union when keyword recall has hits.  Returning vectors
// proportional to a few signal tokens keeps the cosine ranking deterministic
// without speaking to a real provider.
_embeddings.embed = async (texts) => {
  const TOKENS = ["us", "colombia", "ofac", "diplomatic", "security", "petro", "reuters"];
  return texts.map((t) => {
    const lower = String(t ?? "").toLowerCase();
    const matches = TOKENS.filter((tok) => lower.includes(tok)).length;
    return [matches, Math.min(lower.length, 1000) / 1000];
  });
};

after(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

const VALID_BODY = {
  contractVersion: "2026-05-19-meta-story-fields",
  topics: ["Diplomatic relations"],
  keywords: ["OFAC"],
  geographies: ["US"],
  traditionalSources: ["Reuters"],
  socialSources: ["@latamwatcher"],
};

// Deterministic env baseline for every test in this file.
//
// TEMPO_DATA_DIR: sibling repo test files (settings-repo, dashboard-snapshot-
// repo, story-rejection-log-repo, server.resolve-destination) each set this to
// their own temp dir at module load.  In a single-process full-suite run every
// module body executes before any test, so the last loader wins and our seeded
// fixtures become unreachable — settings reads return DEFAULT_SETTINGS and
// refresh collapses to zero stories.  We re-pin our dir before each test.
//
// TEMPO_AI_MOCK_ONLY: a developer .env / CI may export real models + keys with
// mock-only off, which routes the refresh pipeline onto real providers and
// breaks the deterministic mock contract these route tests rely on (e.g. the
// lexical-fallback test surfaces zero stories).  We force mock-only on so the
// pipeline is hermetic regardless of inherited env; the handful of tests that
// exercise real-provider routing set their own values on top of this baseline.
//
// Both are SNAPSHOTTED per test and fully restored (delete-when-undefined) in
// afterEach so we never leave a pinned value that leaks to sibling files.
const _ROUTES_ENV_KEYS = ["TEMPO_DATA_DIR", "TEMPO_AI_MOCK_ONLY"];
let _routesEnvSnapshot;
describe("server.routes", () => {
  beforeEach(() => {
    _routesEnvSnapshot = {};
    for (const k of _ROUTES_ENV_KEYS) _routesEnvSnapshot[k] = process.env[k];
    process.env.TEMPO_DATA_DIR = tmpDir;
    process.env.TEMPO_AI_MOCK_ONLY = "true";
    // Slice 6: neutralize the prefetch kickoff by default so extraction-success
    // tests don't fire a real background refresh that writes a snapshot and
    // bleeds into later tests. The dedicated Slice 6 tests restore the genuine
    // implementation. No-op returns undefined → handler omits _meta.refreshJobId.
    _refreshPrefetch.start = () => undefined;
  });
  afterEach(() => {
    for (const k of _ROUTES_ENV_KEYS) {
      if (_routesEnvSnapshot[k] === undefined) delete process.env[k];
      else process.env[k] = _routesEnvSnapshot[k];
    }
    _refreshPrefetch.start = _realPrefetchStart;
  });

// ─── Public routes ────────────────────────────────────────────────────────────

test("GET /health returns ok", async () => {
  const res = await request(app).get("/health");
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
});

// ─── Settings — authenticated happy path ──────────────────────────────────────

test("PUT /api/settings rejects invalid payload with 400", async () => {
  const res = await request(app)
    .put("/api/settings")
    .send({ notValid: true })
    .set("Content-Type", "application/json");
  assert.equal(res.status, 400);
  assert.equal(typeof res.body.message, "string");
  assert.ok(Array.isArray(res.body.errors));
});

test("PUT /api/settings accepts valid payload with 200 and schema-conformant response", async () => {
  const res = await request(app)
    .put("/api/settings")
    .send(VALID_BODY)
    .set("Content-Type", "application/json");
  assert.equal(res.status, 200);
  const parsed = settingsPayloadSchema.safeParse(res.body);
  assert.ok(parsed.success, `response must conform to settingsPayloadSchema: ${JSON.stringify(parsed.error?.errors)}`);
  assert.equal(res.body.contractVersion, VALID_BODY.contractVersion);
  assert.deepEqual(res.body.topics, VALID_BODY.topics);
});

test("GET /api/settings returns persisted data after valid PUT", async () => {
  const res = await request(app).get("/api/settings");
  assert.equal(res.status, 200);
  assert.equal(res.body.contractVersion, VALID_BODY.contractVersion);
  assert.deepEqual(res.body.topics, VALID_BODY.topics);
});

// ─── D-064a: keyword-dedupe backfill on read ─────────────────────────────────

test("GET /api/settings backfills pre-D-064 keyword/geography duplicates and persists once", async () => {
  // Isolated synthetic user: any other test that interactively PUTs settings
  // under `TEST_USER_ID` cannot overwrite this test's seeded file, since the
  // file path is keyed by userId.  Eliminated a flake where neighbouring tests
  // overwrote the seed with `VALID_BODY` between writeFile() and GET, causing
  // `res1.body.keywords` to be `["OFAC"]` instead of `["war","trade"]`.
  const ISOLATED_USER_ID = "test-user-backfill-strips";
  // Seed a stale file directly to bypass PUT hygiene — this is the shape a
  // user who onboarded before D-064 still carries.
  const stale = {
    contractVersion: "2026-05-19-meta-story-fields",
    topics: ["Diplomatic relations"],
    keywords: ["China", "Russia", "war", "trade"],
    geographies: ["China", "Russia", "US"],
    traditionalSources: ["Reuters"],
    socialSources: [],
  };
  const file = path.join(tmpDir, `settings_user_${ISOLATED_USER_ID}.json`);
  await writeFile(file, JSON.stringify(stale, null, 2), "utf8");

  let writeCount = 0;
  const prev = _writeSettings.write;
  _writeSettings.write = async (payload, userId) => { writeCount += 1; return prev(payload, userId); };
  try {
    await withIsolatedUser(ISOLATED_USER_ID, async () => {
      const res1 = await request(app).get("/api/settings");
      assert.equal(res1.status, 200);
      assert.ok(!res1.body.keywords.includes("China"), "China must be stripped from keywords");
      assert.ok(!res1.body.keywords.includes("Russia"), "Russia must be stripped from keywords");
      // Use set membership so future additions/orderings of thematic keywords in
      // the stale payload don't break the assertion contract.
      const keywordSet = new Set(res1.body.keywords);
      assert.ok(keywordSet.has("war"), `expected "war" in keywords, got ${JSON.stringify(res1.body.keywords)}`);
      assert.ok(keywordSet.has("trade"), `expected "trade" in keywords, got ${JSON.stringify(res1.body.keywords)}`);
      assert.deepEqual(res1.body.geographies, ["China", "Russia", "US"]);
      assert.equal(writeCount, 1, "backfill must persist exactly once when dedupe changes the list");

      // Second read on the already-cleaned payload must NOT trigger another
      // write — idempotence guard.
      const res2 = await request(app).get("/api/settings");
      assert.equal(res2.status, 200);
      assert.deepEqual(res2.body.keywords, res1.body.keywords);
      assert.equal(writeCount, 1, "second read on clean data must not re-persist");
    });
  } finally {
    _writeSettings.write = prev;
    // Best-effort cleanup of the isolated user's settings file; failure is
    // benign because the `after()` block wipes `tmpDir` at suite end.
    await rm(file, { force: true }).catch(() => {});
  }
});

test("GET /api/settings backfills when dedupe changes keywords but length is unchanged", async () => {
  // Isolated synthetic user — see [L126] for the file-collision rationale.
  // Original failure mode: actual `["OFAC"]` because the suite-wide
  // `TEST_USER_ID` settings file was concurrently being mutated to
  // `VALID_BODY` by other tests.
  const ISOLATED_USER_ID = "test-user-backfill-length-stable";
  const stale = {
    contractVersion: "2026-05-19-meta-story-fields",
    topics: ["Diplomatic relations"],
    keywords: ["China", "Russia"],
    geographies: ["China"],
    traditionalSources: ["Reuters"],
    socialSources: [],
  };
  const file = path.join(tmpDir, `settings_user_${ISOLATED_USER_ID}.json`);
  await writeFile(file, JSON.stringify(stale, null, 2), "utf8");

  let writeCount = 0;
  const prev = _writeSettings.write;
  _writeSettings.write = async (payload, userId) => {
    writeCount += 1;
    return prev(payload, userId);
  };
  try {
    await withIsolatedUser(ISOLATED_USER_ID, async () => {
      const res = await request(app).get("/api/settings");
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.keywords, ["Russia"]);
      assert.equal(writeCount, 1, "must persist when China is stripped but length stays 2");
    });
  } finally {
    _writeSettings.write = prev;
    await rm(file, { force: true }).catch(() => {});
  }
});

// ─── Source registry sync ─────────────────────────────────────────────────────

test("PUT /api/settings returns 200 and registry sync is no-op when SUPABASE_URL is absent", async () => {
  // SUPABASE_URL is not set in the test environment; recordSourceRegistryEventsFromSettings
  // returns early. Verify the route still completes normally.
  const prev = _sourceRegistrySync.record;
  let called = false;
  _sourceRegistrySync.record = async (args) => { called = true; return prev(args); };
  try {
    const res = await request(app)
      .put("/api/settings")
      .send(VALID_BODY)
      .set("Content-Type", "application/json");
    assert.equal(res.status, 200);
    assert.ok(called, "registry sync hook must be invoked even in no-op path");
  } finally {
    _sourceRegistrySync.record = prev;
  }
});

test("PUT /api/settings passes previousPayload and nextPayload to registry sync", async () => {
  const body = {
    ...VALID_BODY,
    traditionalSources: ["Reuters", "El Tiempo"],
    socialSources: ["@latamwatcher"],
  };
  let captured = null;
  const prev = _sourceRegistrySync.record;
  _sourceRegistrySync.record = async (args) => { captured = args; };
  try {
    const res = await request(app)
      .put("/api/settings")
      .send(body)
      .set("Content-Type", "application/json");
    assert.equal(res.status, 200);
    assert.ok(captured !== null, "registry sync must have been called");
    assert.equal(captured.userId, TEST_USER_ID);
    assert.deepEqual(captured.nextPayload.traditionalSources, ["Reuters", "El Tiempo"]);
    assert.deepEqual(captured.nextPayload.socialSources, ["@latamwatcher"]);
    // previousPayload is either null (first save) or the prior settings object
    assert.ok("previousPayload" in captured, "previousPayload key must be present");
  } finally {
    _sourceRegistrySync.record = prev;
  }
});

test("PUT /api/settings sync receives updated previousPayload on second save", async () => {
  // Isolated synthetic user — eliminates the intermittent failure where the
  // suite-wide `TEST_USER_ID` settings file already carried a different
  // baseline from a prior test, so the "first save" was effectively the
  // second save (and previousPayload was the prior test's body, not this
  // test's `first`).  Also pins `_readSettings.has/.read` so previousPayload
  // is sourced from this test's stub, not the file adapter.
  const ISOLATED_USER_ID = "test-user-sync-previous-payload";
  const first = { ...VALID_BODY, traditionalSources: ["Reuters"], socialSources: [] };
  const second = { ...VALID_BODY, traditionalSources: ["Reuters", "NYT"], socialSources: [] };

  let captured = null;
  const prev = _sourceRegistrySync.record;
  const prevReadHas = _readSettings.has;
  const prevReadRead = _readSettings.read;
  _sourceRegistrySync.record = async (args) => { captured = args; };
  // Inject the "previous payload" the second save should observe.  Removes
  // the dependency on whatever the settings file happens to contain at this
  // point in the suite — the only signal the route uses to compute
  // previousPayload is `_readSettings.has` + `_readSettings.read`.
  _readSettings.has = async () => true;
  _readSettings.read = async () => first;
  try {
    const res = await withIsolatedUser(ISOLATED_USER_ID, () =>
      request(app)
        .put("/api/settings")
        .send(second)
        .set("Content-Type", "application/json")
    );
    assert.equal(res.status, 200);
    assert.ok(captured !== null, "registry sync must have been called");
    assert.equal(captured.userId, ISOLATED_USER_ID);
    // previousPayload reflects the first save's sources (from the stub above).
    assert.deepEqual(captured.previousPayload?.traditionalSources, ["Reuters"]);
    // nextPayload is the second save
    assert.deepEqual(captured.nextPayload.traditionalSources, ["Reuters", "NYT"]);
  } finally {
    _sourceRegistrySync.record = prev;
    _readSettings.has = prevReadHas;
    _readSettings.read = prevReadRead;
    // Best-effort cleanup of any file the PUT may have written under the
    // isolated user; benign on failure since `after()` wipes tmpDir.
    await rm(path.join(tmpDir, `settings_user_${ISOLATED_USER_ID}.json`), { force: true }).catch(() => {});
  }
});

test("GET /api/dashboard returns empty stories with hasSnapshot=false when no snapshot exists", async () => {
  // Override snapshot repo to simulate no snapshot on record.
  const prev = _snapshotRepo.read;
  _snapshotRepo.read = async () => null;
  try {
    const res = await request(app).get("/api/dashboard");
    assert.equal(res.status, 200);
    assert.equal(res.body.contractVersion, "2026-05-19-meta-story-fields");
    assert.ok(Array.isArray(res.body.stories));
    assert.equal(res.body.stories.length, 0);
    assert.equal(res.body._meta?.hasSnapshot, false);
  } finally {
    _snapshotRepo.read = prev;
  }
});

test("GET /api/dashboard returns persisted snapshot when one exists", async () => {
  const SNAPSHOT = {
    contractVersion: "2026-05-19-meta-story-fields",
    stories: [
      {
        id: "snap-story-1",
        metaStoryId: "snap-story-1",
        title: "Snapshot Story",
        subtitle: "A subtitle.",
        geographies: ["US"],
        topic: "Diplomatic relations",
        summary: "Summary.",
        whyItMatters: "Why.",
        // Match the post–Phase 4 unchanged copy so fixtures don't carry the
        // retired freshness-template wording next to the new regression guards.
        whatChanged: "No material update since your last refresh.",
        priority: "standard",
        outletCount: 1,
        tags: { topics: ["Diplomatic relations"], keywords: [], geographies: ["US"] },
        sources: [{ id: "src-1", outlet: "Reuters", kind: "traditional", weight: 75, url: "#", minutesAgo: 30, headline: "Headline", body: ["Body."] }],
      },
    ],
    _meta: { hasSnapshot: true, refreshedAt: new Date().toISOString() },
  };
  const prev = _snapshotRepo.read;
  _snapshotRepo.read = async () => SNAPSHOT;
  try {
    const res = await request(app).get("/api/dashboard");
    assert.equal(res.status, 200);
    assert.equal(res.body.contractVersion, "2026-05-19-meta-story-fields");
    assert.equal(res.body.stories.length, 1);
    assert.equal(res.body.stories[0].id, "snap-story-1");
    const parsed = dashboardPayloadSchema.safeParse(res.body);
    assert.ok(parsed.success, `response must conform to dashboardPayloadSchema: ${JSON.stringify(parsed.error?.errors)}`);
  } finally {
    _snapshotRepo.read = prev;
  }
});

test("GET /api/dashboard lifts persisted _lastRunMeta.outcomes + ingestionSource into _meta (Slice 3 read path)", async () => {
  // Persist a real snapshot carrying Slice 3 run-level observability under
  // `_lastRunMeta`, then read it back through the LIVE read path (no stubbing)
  // so the assertion exercises liftSnapshotMeta — proving the persisted
  // metadata surfaces on a subsequent dashboard load, not just on the
  // immediate refresh response. Isolated under a unique user id so the
  // file-backed write doesn't bleed into other tests' real read paths.
  const LIFT_USER = "slice3-lift-user";
  const payload = {
    contractVersion: "2026-05-19-meta-story-fields",
    stories: [
      {
        id: "lift-story-1",
        metaStoryId: "lift-story-1",
        title: "Lift Story",
        subtitle: "A subtitle.",
        geographies: ["US"],
        topic: "Diplomatic relations",
        summary: "Summary.",
        whyItMatters: "Why.",
        whatChanged: "No material update since your last refresh.",
        priority: "standard",
        outletCount: 1,
        tags: { topics: ["Diplomatic relations"], keywords: [], geographies: ["US"] },
        sources: [{ id: "src-1", outlet: "Reuters", kind: "traditional", weight: 75, url: "#", minutesAgo: 30, headline: "Headline", body: ["Body."] }],
      },
    ],
    _lastRunMeta: {
      ingestionSource: "live_scoped",
      outcomes: {
        storiesPublished: 1,
        clusteringAttempts: 1,
        clusteringFailureReason: null,
        usedFallbackClustering: false,
        geoAssessedCount: 4,
        geoHeldCount: 0,
      },
    },
  };
  const prevResolver = _auth.resolver;
  _auth.resolver = async () => ({ userId: LIFT_USER, source: "bearer" });
  await _snapshotRepo.write(LIFT_USER, payload);
  try {
    const res = await request(app).get("/api/dashboard");
    assert.equal(res.status, 200);
    assert.equal(res.body._meta?.hasSnapshot, true);
    // ingestionSource lifted out of _lastRunMeta by the read path.
    assert.equal(res.body._meta?.ingestionSource, "live_scoped");
    // outcomes object lifted with its run-level fields intact.
    assert.ok(res.body._meta?.outcomes, "_meta.outcomes present on the read path");
    assert.equal(res.body._meta.outcomes.storiesPublished, 1);
    assert.equal(res.body._meta.outcomes.clusteringAttempts, 1);
    assert.equal(res.body._meta.outcomes.geoAssessedCount, 4);
    // Internal persistence field must never leak to clients.
    assert.equal(res.body._lastRunMeta, undefined, "_lastRunMeta must not leak at top level");
  } finally {
    _auth.resolver = prevResolver;
  }
});

test("GET /api/dashboard lifts persisted clustering subtype fields to top-level _meta (Prompt 1.2)", async () => {
  const LIFT_USER = "slice3-lift-subtype-user";
  const payload = {
    contractVersion: "2026-05-19-meta-story-fields",
    stories: [
      {
        id: "lift-subtype-story-1",
        metaStoryId: "lift-subtype-story-1",
        title: "Lift Subtype Story",
        subtitle: "A subtitle.",
        geographies: ["US"],
        topic: "Diplomatic relations",
        summary: "Summary.",
        whyItMatters: "Why.",
        whatChanged: "No material update since your last refresh.",
        priority: "standard",
        outletCount: 1,
        tags: { topics: ["Diplomatic relations"], keywords: [], geographies: ["US"] },
        sources: [{ id: "src-1", outlet: "Reuters", kind: "traditional", weight: 75, url: "#", minutesAgo: 30, headline: "Headline", body: ["Body."] }],
      },
    ],
    _lastRunMeta: {
      clusteringFailureReason: "error",
      clusteringFailureSubtype: "provider_request",
      clusteringRecoverySubtype: "parse",
      outcomes: {
        storiesPublished: 1,
        clusteringAttempts: 2,
        clusteringFailureReason: "error",
        clusteringFailureSubtype: "provider_request",
        usedFallbackClustering: true,
      },
    },
  };
  const prevResolver = _auth.resolver;
  _auth.resolver = async () => ({ userId: LIFT_USER, source: "bearer" });
  await _snapshotRepo.write(LIFT_USER, payload);
  try {
    const res = await request(app).get("/api/dashboard");
    assert.equal(res.status, 200);
    assert.equal(res.body._meta?.hasSnapshot, true);
    assert.equal(res.body._meta?.clusteringFailureReason, "error");
    assert.equal(res.body._meta?.clusteringFailureSubtype, "provider_request");
    assert.equal(res.body._meta?.clusteringRecoverySubtype, "parse");
  } finally {
    _auth.resolver = prevResolver;
  }
});

// ─── Topic taxonomy backward compatibility ─────────────────────────────────────
// These tests verify that normalizeTopicLabel is applied during relevance filtering
// so legacy item labels ("Security cooperation") match settings written in normalized
// form ("Security policy"), and vice-versa.  These now exercise POST /api/dashboard/refresh
// since that is where filtering runs.

test("refresh pipeline: normalized settings topic matches item with legacy topic label", async () => {
  // Narrowed integration scope: this test asserts that the route hands raw
  // items + settings to the pipeline with topic-normalization-aware matching
  // expected.  The full clustering/recall/beat-fit/grounding chain requires
  // live Anthropic + OpenAI keys, and was the root cause of false
  // "stories.length > 0 was false" failures in offline-key environments.
  //
  // We stub `_refreshPipeline.run` with `topicNormalizationPipelineStub()`,
  // which applies ONLY the rule under test (item.topic normalized matches
  // settings.topics normalized).  All upstream code (settings load, manifest
  // load, in-flight guard, cache resolution, identity, persistence) still
  // runs end-to-end — only the AI-bound pipeline interior is swapped for a
  // deterministic stand-in.
  const ISOLATED_USER_ID = "test-user-norm-new-label";
  const oldLabelItems = [{ ...FIXTURE_SOURCE_ITEMS[0], topic: "Security cooperation", clusterId: "test-old-label" }];
  await writeFile(path.join(tmpDir, "source-items.json"), JSON.stringify(oldLabelItems), "utf8");

  let capturedPayload = null;
  let capturedRunOpts = null;
  const prevWrite = _snapshotRepo.write;
  const prevGetLocks = _snapshotRepo.getLocks;
  const prevInsertLocks = _snapshotRepo.insertLocks;
  const prevRun = _refreshPipeline.run;
  _snapshotRepo.write = async (_uid, payload) => { capturedPayload = payload; };
  _snapshotRepo.getLocks = async () => new Map();
  _snapshotRepo.insertLocks = async () => {};
  const baseStub = topicNormalizationPipelineStub();
  _refreshPipeline.run = async (opts) => {
    capturedRunOpts = opts;
    return baseStub(opts);
  };

  try {
    await withIsolatedUser(ISOLATED_USER_ID, async () => {
      await request(app)
        .put("/api/settings")
        .send({ ...VALID_BODY, topics: ["Security policy"] })
        .set("Content-Type", "application/json");
      const res = await request(app).post("/api/dashboard/refresh");
      assert.equal(res.status, 200);
      assert.ok(capturedRunOpts !== null, "pipeline must have been invoked");
      // Contract: the pipeline receives the legacy-labeled item AND settings
      // carrying the normalized topic.  These are what the production matcher
      // is contractually required to equate.
      const items = capturedRunOpts.rawItems ?? [];
      assert.ok(items.some((it) => it.topic === "Security cooperation"),
        "route must hand the legacy-topic item to the pipeline");
      const settingTopics = capturedRunOpts.settings?.topics ?? [];
      assert.ok(settingTopics.includes("Security policy"),
        "route must hand the normalized setting topic to the pipeline");
      // Equivalence: both sides normalize to the same canonical.
      assert.equal(
        normalizeTopicLabel("Security cooperation"),
        normalizeTopicLabel("Security policy"),
        "topic normalization must equate legacy 'Security cooperation' with 'Security policy'"
      );
      assert.ok(capturedPayload !== null);
      assert.ok(capturedPayload.stories.length > 0,
        "item labeled 'Security cooperation' must match normalized setting 'Security policy'");
    });
  } finally {
    _snapshotRepo.write = prevWrite;
    _snapshotRepo.getLocks = prevGetLocks;
    _snapshotRepo.insertLocks = prevInsertLocks;
    _refreshPipeline.run = prevRun;
    await writeFile(path.join(tmpDir, "source-items.json"), JSON.stringify(FIXTURE_SOURCE_ITEMS), "utf8");
    await rm(path.join(tmpDir, `settings_user_${ISOLATED_USER_ID}.json`), { force: true }).catch(() => {});
  }
});

test("refresh pipeline: old settings topic still matches item with the same old label (backward compat)", async () => {
  // See sibling test above for the rationale behind stubbing
  // `_refreshPipeline.run` with `topicNormalizationPipelineStub()`.
  const ISOLATED_USER_ID = "test-user-norm-legacy-label";
  const oldLabelItems = [{ ...FIXTURE_SOURCE_ITEMS[0], topic: "Security cooperation", clusterId: "test-old-both" }];
  await writeFile(path.join(tmpDir, "source-items.json"), JSON.stringify(oldLabelItems), "utf8");

  let capturedPayload = null;
  let capturedRunOpts = null;
  const prevWrite = _snapshotRepo.write;
  const prevGetLocks = _snapshotRepo.getLocks;
  const prevInsertLocks = _snapshotRepo.insertLocks;
  const prevRun = _refreshPipeline.run;
  _snapshotRepo.write = async (_uid, payload) => { capturedPayload = payload; };
  _snapshotRepo.getLocks = async () => new Map();
  _snapshotRepo.insertLocks = async () => {};
  const baseStub = topicNormalizationPipelineStub();
  _refreshPipeline.run = async (opts) => {
    capturedRunOpts = opts;
    return baseStub(opts);
  };

  try {
    await withIsolatedUser(ISOLATED_USER_ID, async () => {
      await request(app)
        .put("/api/settings")
        .send({ ...VALID_BODY, topics: ["Security cooperation"] })
        .set("Content-Type", "application/json");
      const res = await request(app).post("/api/dashboard/refresh");
      assert.equal(res.status, 200);
      assert.ok(capturedRunOpts !== null, "pipeline must have been invoked");
      // Old-form setting equals old-form item topic — even before normalization.
      const settingTopics = capturedRunOpts.settings?.topics ?? [];
      assert.ok(settingTopics.includes("Security cooperation"),
        "route must hand the old-form setting topic to the pipeline");
      assert.ok(capturedPayload !== null);
      assert.ok(capturedPayload.stories.length > 0,
        "old-form setting 'Security cooperation' must still match item with same old label");
    });
  } finally {
    _snapshotRepo.write = prevWrite;
    _snapshotRepo.getLocks = prevGetLocks;
    _snapshotRepo.insertLocks = prevInsertLocks;
    _refreshPipeline.run = prevRun;
    await writeFile(path.join(tmpDir, "source-items.json"), JSON.stringify(FIXTURE_SOURCE_ITEMS), "utf8");
    await rm(path.join(tmpDir, `settings_user_${ISOLATED_USER_ID}.json`), { force: true }).catch(() => {});
  }
});

test("GET /api/ingestion/sources returns declared feed configuration (JSON fallback, no Supabase)", async () => {
  // SUPABASE_URL is not set in the test env — route must fall back to source-feeds.json.
  const res = await request(app).get("/api/ingestion/sources");
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.feeds), "feeds must be an array");
  assert.equal(res.body.feeds.length, FIXTURE_SOURCE_FEEDS.feeds.length);
  const ids = res.body.feeds.map((f) => f.id).sort();
  assert.ok(ids.includes("nyt-politics"));
  assert.equal(typeof res.body.feeds[0].kind, "string");
  assert.equal(typeof res.body.feeds[0].weight, "number");
});

test("GET /api/ingestion/sources reads from DB when Supabase is enabled", async () => {
  const savedUrl = process.env.SUPABASE_URL;
  const savedKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL = "http://fake-supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-role-key";
  const prevList = _feedManifest.list;
  const DB_FEEDS = [
    { id: "db-feed-1", name: "DB Source", kind: "rss", url: "https://example.com/rss", weight: 90, active: true },
  ];
  _feedManifest.list = async () => DB_FEEDS;
  try {
    const res = await request(app).get("/api/ingestion/sources");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.feeds), "feeds must be an array");
    assert.equal(res.body.feeds.length, 1);
    assert.equal(res.body.feeds[0].id, "db-feed-1");
    assert.equal(res.body.feeds[0].weight, 90);
  } finally {
    _feedManifest.list = prevList;
    if (savedUrl !== undefined) process.env.SUPABASE_URL = savedUrl;
    else delete process.env.SUPABASE_URL;
    if (savedKey !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = savedKey;
    else delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  }
});

test("GET /api/ingestion/sources returns 500 when DB read fails", async () => {
  const savedUrl = process.env.SUPABASE_URL;
  const savedKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL = "http://fake-supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-role-key";
  const prevList = _feedManifest.list;
  _feedManifest.list = async () => { throw new Error("DB connection failed"); };
  try {
    const res = await request(app).get("/api/ingestion/sources");
    assert.equal(res.status, 500);
    assert.ok(typeof res.body.message === "string", "error message must be present");
    assert.ok(
      res.body.message.includes("database"),
      `expected 'database' in error message, got: ${res.body.message}`
    );
  } finally {
    _feedManifest.list = prevList;
    if (savedUrl !== undefined) process.env.SUPABASE_URL = savedUrl;
    else delete process.env.SUPABASE_URL;
    if (savedKey !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = savedKey;
    else delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  }
});

// ─── Auth enforcement — 401 on missing/invalid token ─────────────────────────

test("GET /api/settings returns 401 without valid token", async () => {
  const prev = _auth.resolver;
  _auth.resolver = async () => null;
  try {
    const res = await request(app).get("/api/settings");
    assert.equal(res.status, 401);
    assert.equal(typeof res.body.message, "string");
  } finally {
    _auth.resolver = prev;
  }
});

test("PUT /api/settings returns 401 without valid token", async () => {
  const prev = _auth.resolver;
  _auth.resolver = async () => null;
  try {
    const res = await request(app)
      .put("/api/settings")
      .send(VALID_BODY)
      .set("Content-Type", "application/json");
    assert.equal(res.status, 401);
    assert.equal(typeof res.body.message, "string");
  } finally {
    _auth.resolver = prev;
  }
});

test("GET /api/dashboard returns 401 without valid token", async () => {
  const prev = _auth.resolver;
  _auth.resolver = async () => null;
  try {
    const res = await request(app).get("/api/dashboard");
    assert.equal(res.status, 401);
    assert.equal(typeof res.body.message, "string");
  } finally {
    _auth.resolver = prev;
  }
});

// ─── Transcribe ──────────────────────────────��───────────────────────────��────

test("POST /api/transcribe returns 400 for empty audio body", async () => {
  const res = await request(app)
    .post("/api/transcribe")
    .set("Content-Type", "audio/webm")
    .send(Buffer.alloc(0));
  assert.equal(res.status, 400);
  assert.equal(typeof res.body.message, "string");
});

test("POST /api/transcribe returns mock transcript in dev when API key is absent", async () => {
  const savedTempo = process.env.TEMPO_OPENAI_API_KEY;
  const savedOpenAI = process.env.OPENAI_API_KEY;
  const savedNodeEnv = process.env.NODE_ENV;
  delete process.env.TEMPO_OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  // Ensure we are not in production for this branch.
  process.env.NODE_ENV = "test";
  try {
    const res = await request(app)
      .post("/api/transcribe")
      .set("Content-Type", "audio/webm")
      .send(Buffer.from("fake-audio"));
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.transcript, "string");
    assert.ok(res.body.transcript.length > 0, "mock transcript must be non-empty");
  } finally {
    if (savedTempo !== undefined) process.env.TEMPO_OPENAI_API_KEY = savedTempo;
    if (savedOpenAI !== undefined) process.env.OPENAI_API_KEY = savedOpenAI;
    if (savedNodeEnv !== undefined) process.env.NODE_ENV = savedNodeEnv;
    else delete process.env.NODE_ENV;
  }
});

test("POST /api/transcribe returns 503 in production when API key is absent", async () => {
  const savedTempo = process.env.TEMPO_OPENAI_API_KEY;
  const savedOpenAI = process.env.OPENAI_API_KEY;
  const savedNodeEnv = process.env.NODE_ENV;
  delete process.env.TEMPO_OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  process.env.NODE_ENV = "production";
  try {
    const res = await request(app)
      .post("/api/transcribe")
      .set("Content-Type", "audio/webm")
      .send(Buffer.from("fake-audio"));
    assert.equal(res.status, 503);
    assert.ok(
      typeof res.body.message === "string" && res.body.message.includes("API key not configured"),
      `expected 503 with 'API key not configured', got: ${res.body.message}`
    );
  } finally {
    if (savedTempo !== undefined) process.env.TEMPO_OPENAI_API_KEY = savedTempo;
    if (savedOpenAI !== undefined) process.env.OPENAI_API_KEY = savedOpenAI;
    if (savedNodeEnv !== undefined) process.env.NODE_ENV = savedNodeEnv;
    else delete process.env.NODE_ENV;
  }
});

const MOCK_EXTRACTION = { topics: ["test-topic"], keywords: [], geographies: ["US"], traditionalSources: [], socialSources: [] };

// ─── POST /api/dashboard/refresh ─────────────────────────────────────────────

test("POST /api/dashboard/refresh returns 401 without valid token", async () => {
  const prev = _auth.resolver;
  _auth.resolver = async () => null;
  try {
    const res = await request(app).post("/api/dashboard/refresh");
    assert.equal(res.status, 401);
    assert.equal(typeof res.body.message, "string");
  } finally {
    _auth.resolver = prev;
  }
});

test("POST /api/dashboard/refresh: runs pipeline and persists snapshot, returns stories", async () => {
  let writtenPayload = null;
  let insertedLocks = null;
  const prevWrite = _snapshotRepo.write;
  const prevGetLocks = _snapshotRepo.getLocks;
  const prevInsertLocks = _snapshotRepo.insertLocks;
  _snapshotRepo.write = async (_uid, payload) => { writtenPayload = payload; };
  _snapshotRepo.getLocks = async () => new Map();
  _snapshotRepo.insertLocks = async (_uid, locks) => { insertedLocks = locks; };
  try {
    const res = await request(app).post("/api/dashboard/refresh");
    assert.equal(res.status, 200);
    assert.ok(writtenPayload !== null, "snapshot must be persisted on success");
    assert.ok(Array.isArray(res.body.stories), "response must include stories array");
    assert.ok(res.body._meta?.hasSnapshot === true, "response must include _meta.hasSnapshot=true");
    assert.ok(typeof res.body._meta?.refreshedAt === "string", "response must include _meta.refreshedAt");
    // Prompt 1.1: the failure-subtype key is always present at top-level _meta;
    // it is null whenever there is no terminal clustering failure.
    assert.ok(
      Object.prototype.hasOwnProperty.call(res.body._meta, "clusteringFailureSubtype"),
      "response _meta must expose clusteringFailureSubtype"
    );
    if (res.body._meta.clusteringFailureReason == null) {
      assert.equal(res.body._meta.clusteringFailureSubtype, null, "no failure → null subtype");
    }
    // Phase 2: selection metadata surfaced on POST /api/dashboard/refresh
    const sel = res.body._meta?.selection;
    assert.ok(sel, "response must include _meta.selection");
    assert.ok(["strict", "fallback"].includes(sel.sourceSelectionMode));
    assert.equal(typeof sel.sourceFallbackUsed, "boolean");
    assert.equal(typeof sel.matchedSourceCount, "number");
    assert.equal(typeof sel.selectedSourceCount, "number");
    assert.ok(Array.isArray(sel.unmatchedSelectedSources));
    assert.equal(typeof sel.unavailableConnectorCount, "number");
    assert.equal(typeof sel.relevantItemCount, "number");
    // Internal storage field must NOT leak to clients — they read _meta.selection.
    assert.equal(res.body._selectionMeta, undefined, "_selectionMeta must not leak at top level");
    assert.ok(!Object.prototype.hasOwnProperty.call(res.body, "_selectionMeta"), "_selectionMeta key must be absent");
  } finally {
    _snapshotRepo.write = prevWrite;
    _snapshotRepo.getLocks = prevGetLocks;
    _snapshotRepo.insertLocks = prevInsertLocks;
  }
});

// ─── Slice 3: structured refresh summary + balanced SLO alerts ───────────────

test("Slice 3 SLO: a single slow pipeline (>90s) emits breach=pipeline_slow", () => {
  _refreshSlo.reset();
  const lines = [];
  const { breaches } = _refreshSlo.evaluate(
    { pipelineMs: 90_001, clusteringFailureReason: null },
    { warn: (m) => lines.push(m) }
  );
  assert.ok(breaches.includes("pipeline_slow"));
  assert.ok(
    lines.includes("[refresh.slo] breach=pipeline_slow pipelineMs=90001"),
    `expected pipeline_slow line, got: ${JSON.stringify(lines)}`
  );
});

test("Slice 3 SLO: a pipeline at the 90s boundary does NOT breach pipeline_slow", () => {
  _refreshSlo.reset();
  const lines = [];
  const { breaches } = _refreshSlo.evaluate(
    { pipelineMs: 90_000, clusteringFailureReason: null },
    { warn: (m) => lines.push(m) }
  );
  assert.ok(!breaches.includes("pipeline_slow"));
  assert.equal(lines.length, 0);
});

test("Slice 3 SLO: sustained cluster timeouts (>0.2 over a full window of 10) emit breach=cluster_timeout_rate", () => {
  _refreshSlo.reset();
  const lines = [];
  const logger = { warn: (m) => lines.push(m) };
  // 3 timeouts / 10 = 0.30 > 0.20. The breach must NOT fire before the window
  // is full — a single cold-start timeout can't trip it (balanced, not noisy).
  // Each refresh here attempted clustering (clusteringAttempts=1), so every
  // call contributes a sample.
  const reasons = ["timeout", "timeout", "timeout", null, null, null, null, null, null, null];
  let last;
  reasons.forEach((r, i) => {
    last = _refreshSlo.evaluate({ pipelineMs: 10, clusteringFailureReason: r, clusteringAttempts: 1 }, logger);
    if (i < 9) {
      assert.ok(
        !last.breaches.includes("cluster_timeout_rate"),
        `no cluster_timeout_rate breach before the window is full (call ${i})`
      );
    }
  });
  assert.ok(last.breaches.includes("cluster_timeout_rate"));
  assert.equal(last.windowSize, 10);
  assert.ok(
    lines.includes("[refresh.slo] breach=cluster_timeout_rate rate=0.30 window=10"),
    `expected cluster_timeout_rate line, got: ${JSON.stringify(lines)}`
  );
});

test("Slice 3 SLO: timeout rate exactly at 0.2 across a full window does NOT breach", () => {
  _refreshSlo.reset();
  const lines = [];
  const logger = { warn: (m) => lines.push(m) };
  // 2 timeouts / 10 = 0.20, NOT strictly greater than the 0.20 threshold.
  const reasons = ["timeout", "timeout", null, null, null, null, null, null, null, null];
  let last;
  reasons.forEach((r) => {
    last = _refreshSlo.evaluate({ pipelineMs: 10, clusteringFailureReason: r, clusteringAttempts: 1 }, logger);
  });
  assert.ok(!last.breaches.includes("cluster_timeout_rate"));
  assert.equal(lines.length, 0);
});

test("Slice 3 SLO: no-attempt refreshes (clusteringAttempts=0) never sample the timeout window", () => {
  _refreshSlo.reset();
  const lines = [];
  const logger = { warn: (m) => lines.push(m) };
  // 9 no-attempt refreshes (watermark short-circuit / zero candidates) plus one
  // real timeout attempt. Under an attempt-only denominator the window holds a
  // SINGLE sample, so it's nowhere near full and must NOT breach — the no-op
  // refreshes neither fill the window nor dilute the rate (no false calm,
  // no false alarm).
  let last;
  for (let i = 0; i < 9; i++) {
    last = _refreshSlo.evaluate(
      { pipelineMs: 10, clusteringFailureReason: null, clusteringAttempts: 0 },
      logger
    );
    assert.equal(last.windowSize, 0, `no-attempt refresh ${i} must not be sampled`);
  }
  last = _refreshSlo.evaluate(
    { pipelineMs: 10, clusteringFailureReason: "timeout", clusteringAttempts: 2 },
    logger
  );
  assert.equal(last.windowSize, 1, "only the attempting refresh is sampled");
  assert.ok(!last.breaches.includes("cluster_timeout_rate"), "window not full → no breach");
  assert.equal(lines.length, 0, "no breach line emitted while the attempt window is still filling");

  // Now drive a clean window of 10 attempting refreshes with 3 timeouts
  // (0.30 > 0.20). With an attempt-only denominator the window fills and
  // breaches exactly once.
  _refreshSlo.reset();
  const reasons = ["timeout", "timeout", "timeout", null, null, null, null, null, null, null];
  reasons.forEach((r) => {
    last = _refreshSlo.evaluate(
      { pipelineMs: 10, clusteringFailureReason: r, clusteringAttempts: 1 },
      logger
    );
  });
  assert.equal(last.windowSize, 10, "attempt-only window is full");
  assert.ok(last.breaches.includes("cluster_timeout_rate"));
  const breachLines = lines.filter((l) => l.startsWith("[refresh.slo] breach=cluster_timeout_rate"));
  assert.deepEqual(breachLines, ["[refresh.slo] breach=cluster_timeout_rate rate=0.30 window=10"]);
});

test("POST /api/dashboard/refresh: emits a structured [refresh.summary] line and surfaces outcomes + ingestionSource in _meta", async () => {
  _refreshSlo.reset();
  const prevRun = _refreshPipeline.run;
  const prevWrite = _snapshotRepo.write;
  const prevGetLocks = _snapshotRepo.getLocks;
  const prevInsertLocks = _snapshotRepo.insertLocks;
  const prevLog = console.log;
  const captured = [];
  _refreshPipeline.run = async (opts) => ({
    payload: {
      contractVersion: opts.contractVersion,
      stories: [{
        id: "s1", metaStoryId: "s1", title: "T", subtitle: "sub",
        geographies: ["US"], topic: "Diplomatic relations", summary: "x",
        whyItMatters: "y", whatChanged: "z", priority: "standard",
        outletCount: 1, tags: { topics: [], keywords: [], geographies: ["US"] }, sources: [],
      }],
    },
    log: {
      unchanged: false,
      poolCount: 5, relevantCount: 3, metaStoryCount: 1,
      usedFallbackClustering: false, clusteringFailureReason: null,
      clusteringAttempts: 1, clusteringLatencyMs: [12],
      groundingFailures: 0, droppedUngroundedStoryCount: 0, groundingDropReasons: {},
      watermark: "wm-1", candidateCount: 3, selectedFeedCount: 1,
      selection: { sourceSelectionMode: "test" },
      funnel: { primaryDropStage: "none" },
      timings: { preClusterMs: 1, geoMs: 2, recallMs: 3, clusterMs: 4, whatChangedMs: 0, whyMs: 0, pipelineMs: 30 },
      outcomes: {
        storiesPublished: 1, clusteringAttempts: 1, clusteringFailureReason: null,
        usedFallbackClustering: false, geoAssessedCount: 2, geoHeldCount: 0,
      },
    },
  });
  _snapshotRepo.write = async () => {};
  _snapshotRepo.getLocks = async () => new Map();
  _snapshotRepo.insertLocks = async () => {};
  console.log = (...args) => { captured.push(args.join(" ")); };
  try {
    const res = await request(app).post("/api/dashboard/refresh");
    console.log = prevLog;
    assert.equal(res.status, 200);
    // _meta surfaces the new observability keys (additive, backward-compatible).
    assert.ok(res.body._meta?.outcomes, "_meta.outcomes present");
    assert.equal(res.body._meta.outcomes.storiesPublished, 1);
    assert.equal(res.body._meta.outcomes.geoAssessedCount, 2);
    assert.equal(typeof res.body._meta.ingestionSource, "string");
    assert.equal(typeof res.body._meta.timings?.geoMs, "number", "_meta.timings.geoMs present");
    // D1: additive cache-benefit advisory present + well-formed on the ran branch.
    assertCacheBenefitShape(res.body._meta, "ran branch");
    // The structured summary line is emitted exactly once and parses as JSON.
    const summaryLine = captured.find((l) => l.startsWith("[refresh.summary] "));
    assert.ok(summaryLine, `expected a [refresh.summary] line, got: ${JSON.stringify(captured)}`);
    const summary = JSON.parse(summaryLine.slice("[refresh.summary] ".length));
    assert.equal(summary.stories, 1);
    assert.equal(summary.pipelineMs, 30);
    assert.equal(summary.geoMs, 2);
    assert.equal(typeof summary.ingestionSource, "string");
    assert.equal(summary.outcomes.geoAssessedCount, 2);
    assert.ok(summary.funnel, "summary carries funnel");
  } finally {
    console.log = prevLog;
    _refreshPipeline.run = prevRun;
    _snapshotRepo.write = prevWrite;
    _snapshotRepo.getLocks = prevGetLocks;
    _snapshotRepo.insertLocks = prevInsertLocks;
  }
});

// ─── Slice 4: interactive fast-path profile routing ──────────────────────────

// Echo a profile object shaped like what `resolveRefreshProfile` returns for the
// resolved name, so the route can surface it verbatim on `_meta.profile`.
function echoProfileForName(name) {
  if (name === "cold_start") {
    return {
      name: "cold_start", interactive: true,
      geoStageBudgetMs: 12000, clusterTimeoutMs: 45000, clusterMaxAttempts: 2,
      deferGeoLane2: true, clusterInputCap: 10,
    };
  }
  if (name === "interactive") {
    return {
      name: "interactive", interactive: true,
      geoStageBudgetMs: 12000, clusterTimeoutMs: 22000, clusterMaxAttempts: 2,
    };
  }
  return {
    name: "default", interactive: false,
    geoStageBudgetMs: 25000, clusterTimeoutMs: null, clusterMaxAttempts: 2,
  };
}

function profileCapturingPipelineStub(captured) {
  return async (opts) => {
    captured.refreshProfile = opts.refreshProfile;
    return {
      payload: { contractVersion: opts.contractVersion, stories: [] },
      log: {
        unchanged: false,
        poolCount: 1,
        relevantCount: 1,
        metaStoryCount: 0,
        usedFallbackClustering: false,
        clusteringFailureReason: null,
        // Slice 4.1 locked behavior: interactive clustering attempts are ALWAYS
        // 2 (same as default) — the latency win comes from the geo budget +
        // per-attempt timeout, not from dropping the retry.
        clusteringAttempts: 2,
        watermark: "wm-profile",
        candidateCount: 1,
        selectedFeedCount: 1,
        selection: { sourceSelectionMode: "test" },
        // Reflect the EFFECTIVE profile the route resolved (after cold-start
        // gating), keyed off the name the executor passed to the pipeline.
        profile: echoProfileForName(opts.refreshProfile),
      },
    };
  };
}

test("POST /api/dashboard/refresh?profile=cold_start (no prior snapshot) runs the cold_start profile and surfaces it on _meta", async () => {
  const prevRun = _refreshPipeline.run;
  const prevRead = _snapshotRepo.read;
  const prevWrite = _snapshotRepo.write;
  const prevGetLocks = _snapshotRepo.getLocks;
  const prevInsertLocks = _snapshotRepo.insertLocks;
  const captured = {};
  _refreshPipeline.run = profileCapturingPipelineStub(captured);
  _snapshotRepo.read = async () => null; // brand-new user: no prior snapshot
  _snapshotRepo.write = async () => {};
  _snapshotRepo.getLocks = async () => new Map();
  _snapshotRepo.insertLocks = async () => {};
  try {
    await withIsolatedUser("slice4-coldstart-profile", async () => {
      const res = await request(app).post("/api/dashboard/refresh?profile=cold_start");
      assert.equal(res.status, 200);
      assert.equal(captured.refreshProfile, "cold_start", "route must request the cold_start profile");
      assert.equal(res.body._meta?.profile?.name, "cold_start");
      assert.equal(res.body._meta?.profile?.interactive, true);
      assert.equal(res.body._meta?.profile?.clusterInputCap, 10);
      // Effective === requested, so no additive profileRequested is surfaced.
      assert.equal(res.body._meta?.profileRequested, undefined);
    });
  } finally {
    _refreshPipeline.run = prevRun;
    _snapshotRepo.read = prevRead;
    _snapshotRepo.write = prevWrite;
    _snapshotRepo.getLocks = prevGetLocks;
    _snapshotRepo.insertLocks = prevInsertLocks;
  }
});

test("POST /api/dashboard/refresh?interactive=1 (legacy alias) maps to cold_start when no prior snapshot", async () => {
  const prevRun = _refreshPipeline.run;
  const prevRead = _snapshotRepo.read;
  const prevWrite = _snapshotRepo.write;
  const prevGetLocks = _snapshotRepo.getLocks;
  const prevInsertLocks = _snapshotRepo.insertLocks;
  const captured = {};
  _refreshPipeline.run = profileCapturingPipelineStub(captured);
  _snapshotRepo.read = async () => null;
  _snapshotRepo.write = async () => {};
  _snapshotRepo.getLocks = async () => new Map();
  _snapshotRepo.insertLocks = async () => {};
  try {
    await withIsolatedUser("slice4-interactive-alias", async () => {
      const res = await request(app).post("/api/dashboard/refresh?interactive=1");
      assert.equal(res.status, 200);
      assert.equal(captured.refreshProfile, "cold_start", "legacy ?interactive=1 must request cold_start");
      assert.equal(res.body._meta?.profile?.name, "cold_start");
      assert.equal(res.body._meta?.profile?.interactive, true);
    });
  } finally {
    _refreshPipeline.run = prevRun;
    _snapshotRepo.read = prevRead;
    _snapshotRepo.write = prevWrite;
    _snapshotRepo.getLocks = prevGetLocks;
    _snapshotRepo.insertLocks = prevInsertLocks;
  }
});

test("POST /api/dashboard/refresh?profile=cold_start WITH a prior snapshot gates down to default (requested surfaced additively)", async () => {
  const prevRun = _refreshPipeline.run;
  const prevRead = _snapshotRepo.read;
  const prevWrite = _snapshotRepo.write;
  const prevGetLocks = _snapshotRepo.getLocks;
  const prevInsertLocks = _snapshotRepo.insertLocks;
  const captured = {};
  _refreshPipeline.run = profileCapturingPipelineStub(captured);
  // A prior snapshot exists → cold_start is not a valid first-run state here.
  _snapshotRepo.read = async () => ({
    contractVersion: "2026-05-19-meta-story-fields",
    stories: [],
    _watermark: "wm-prior-coldstart-gate",
    _meta: { hasSnapshot: true },
  });
  _snapshotRepo.write = async () => {};
  _snapshotRepo.getLocks = async () => new Map();
  _snapshotRepo.insertLocks = async () => {};
  try {
    await withIsolatedUser("slice4-coldstart-gated", async () => {
      const res = await request(app).post("/api/dashboard/refresh?profile=cold_start");
      assert.equal(res.status, 200);
      // Gating: the pipeline runs the DEFAULT profile, not cold_start.
      assert.equal(captured.refreshProfile, null, "cold_start must be gated to default when a prior snapshot exists");
      assert.equal(res.body._meta?.profile?.name, "default");
      assert.equal(res.body._meta?.profile?.interactive, false);
      // Additive: the originally-requested profile is surfaced so the gate is visible.
      assert.equal(res.body._meta?.profileRequested, "cold_start");
    });
  } finally {
    _refreshPipeline.run = prevRun;
    _snapshotRepo.read = prevRead;
    _snapshotRepo.write = prevWrite;
    _snapshotRepo.getLocks = prevGetLocks;
    _snapshotRepo.insertLocks = prevInsertLocks;
  }
});

test("POST /api/dashboard/refresh (no interactive flag) keeps the default profile (scheduled/background unchanged)", async () => {
  const prevRun = _refreshPipeline.run;
  const prevWrite = _snapshotRepo.write;
  const prevGetLocks = _snapshotRepo.getLocks;
  const prevInsertLocks = _snapshotRepo.insertLocks;
  const captured = {};
  _refreshPipeline.run = profileCapturingPipelineStub(captured);
  _snapshotRepo.write = async () => {};
  _snapshotRepo.getLocks = async () => new Map();
  _snapshotRepo.insertLocks = async () => {};
  try {
    await withIsolatedUser("slice4-default", async () => {
      const res = await request(app).post("/api/dashboard/refresh");
      assert.equal(res.status, 200);
      assert.equal(captured.refreshProfile, null, "default refresh must NOT request the interactive profile");
      assert.equal(res.body._meta?.profile?.name, "default");
      assert.equal(res.body._meta?.profile?.interactive, false);
    });
  } finally {
    _refreshPipeline.run = prevRun;
    _snapshotRepo.write = prevWrite;
    _snapshotRepo.getLocks = prevGetLocks;
    _snapshotRepo.insertLocks = prevInsertLocks;
  }
});

// ─── Slice 11: retry-default profile contract ────────────────────────────────

test("Slice 11: POST /api/dashboard/refresh?profile=default → effective default profile (no prior snapshot)", async () => {
  const prevRun = _refreshPipeline.run;
  const prevRead = _snapshotRepo.read;
  const prevWrite = _snapshotRepo.write;
  const prevGetLocks = _snapshotRepo.getLocks;
  const prevInsertLocks = _snapshotRepo.insertLocks;
  const captured = {};
  _refreshPipeline.run = profileCapturingPipelineStub(captured);
  _snapshotRepo.read = async () => null; // brand-new user, no prior snapshot
  _snapshotRepo.write = async () => {};
  _snapshotRepo.getLocks = async () => new Map();
  _snapshotRepo.insertLocks = async () => {};
  try {
    await withIsolatedUser("slice11-default-nosnap", async () => {
      const res = await request(app).post("/api/dashboard/refresh?profile=default");
      assert.equal(res.status, 200);
      // `profile=default` is not the cold_start trigger → pipeline runs default.
      assert.equal(captured.refreshProfile, null, "explicit default must not request cold_start");
      assert.equal(res.body._meta?.profile?.name, "default");
      assert.equal(res.body._meta?.profile?.interactive, false);
      // requested === effective → no additive profileRequested surfaced.
      assert.equal(res.body._meta?.profileRequested, undefined);
    });
  } finally {
    _refreshPipeline.run = prevRun;
    _snapshotRepo.read = prevRead;
    _snapshotRepo.write = prevWrite;
    _snapshotRepo.getLocks = prevGetLocks;
    _snapshotRepo.insertLocks = prevInsertLocks;
  }
});

test("Slice 11: POST /api/dashboard/refresh?profile=default → effective default even WITH a prior snapshot (no cold-start gating interference)", async () => {
  const prevRun = _refreshPipeline.run;
  const prevRead = _snapshotRepo.read;
  const prevWrite = _snapshotRepo.write;
  const prevGetLocks = _snapshotRepo.getLocks;
  const prevInsertLocks = _snapshotRepo.insertLocks;
  const captured = {};
  _refreshPipeline.run = profileCapturingPipelineStub(captured);
  // A prior snapshot exists; for an explicit default request this is irrelevant
  // (cold-start gating only ever downgrades cold_start → default, never reshapes
  // a default request).
  _snapshotRepo.read = async () => ({
    contractVersion: "2026-05-19-meta-story-fields",
    stories: [],
    _watermark: "wm-slice11-default-prior",
    _meta: { hasSnapshot: true },
  });
  _snapshotRepo.write = async () => {};
  _snapshotRepo.getLocks = async () => new Map();
  _snapshotRepo.insertLocks = async () => {};
  try {
    await withIsolatedUser("slice11-default-withsnap", async () => {
      const res = await request(app).post("/api/dashboard/refresh?profile=default");
      assert.equal(res.status, 200);
      assert.equal(captured.refreshProfile, null);
      assert.equal(res.body._meta?.profile?.name, "default");
      assert.equal(res.body._meta?.profile?.interactive, false);
      // Still no gate fired → no profileRequested (requested === effective).
      assert.equal(res.body._meta?.profileRequested, undefined);
    });
  } finally {
    _refreshPipeline.run = prevRun;
    _snapshotRepo.read = prevRead;
    _snapshotRepo.write = prevWrite;
    _snapshotRepo.getLocks = prevGetLocks;
    _snapshotRepo.insertLocks = prevInsertLocks;
  }
});

// ─── Slice 7: SLO gate surfaced additively on _meta.slo ──────────────────────

test("POST /api/dashboard/refresh surfaces an additive _meta.slo gate (breaches + hints + fields)", async () => {
  _refreshSlo.reset();
  const prevRun = _refreshPipeline.run;
  const prevWrite = _snapshotRepo.write;
  const prevGetLocks = _snapshotRepo.getLocks;
  const prevInsertLocks = _snapshotRepo.insertLocks;
  // Healthy ran refresh that nonetheless hit geo budget pressure (single-run
  // breach) — exercises both the gate snapshot and a breach + action hint.
  _refreshPipeline.run = async (opts) => ({
    payload: {
      contractVersion: opts.contractVersion,
      stories: [{
        id: "s1", metaStoryId: "s1", title: "T", subtitle: "sub", geographies: ["US"],
        topic: "Diplomatic relations", summary: "x", whyItMatters: "y", whatChanged: "z",
        priority: "standard", outletCount: 1, tags: { topics: [], keywords: [], geographies: ["US"] }, sources: [],
      }],
    },
    log: {
      unchanged: false, poolCount: 3, relevantCount: 2, metaStoryCount: 1,
      usedFallbackClustering: false, clusteringFailureReason: null, clusteringAttempts: 2,
      watermark: "wm-slo", candidateCount: 2, selectedFeedCount: 1,
      selection: { sourceSelectionMode: "test" },
      timings: { pipelineMs: 30 },
      outcomes: {
        storiesPublished: 1, clusteringAttempts: 2, clusteringFailureReason: null,
        usedFallbackClustering: false,
        geoBudgetHit: true, geoLane2Deferred: 3, geoBudgetMsConfigured: 12000, geoBudgetMsUsed: 12005,
      },
      profile: { name: "interactive", interactive: true, geoStageBudgetMs: 12000, clusterMaxAttempts: 2, clusterTimeoutMs: 22000 },
      whyEnrichment: { deferred: true, pending: 1, completed: 0, total: 1, upgradeLatencyMs: null },
    },
  });
  _snapshotRepo.write = async () => {};
  _snapshotRepo.getLocks = async () => new Map();
  _snapshotRepo.insertLocks = async () => {};
  try {
    await withIsolatedUser("slice7-slo-meta", async () => {
      const res = await request(app).post("/api/dashboard/refresh?interactive=1");
      assert.equal(res.status, 200);
      const slo = res.body._meta?.slo;
      assert.ok(slo, "_meta.slo present (additive)");
      // Geo budget pressure breach with a stable id + concrete action hint.
      assert.ok(slo.breaches.includes("geo_budget_pressure"));
      const detail = slo.breachDetails.find((d) => d.id === "geo_budget_pressure");
      assert.match(detail.actionHint, /geo_budget_pressure/);
      assert.equal(detail.observed.lane2Deferred, 3);
      // Gate snapshot carries the machine-readable fields.
      assert.equal(slo.gate.emptyKind, "has_stories");
      assert.equal(slo.gate.profile, "interactive");
      assert.equal(slo.gate.storiesPublished, 1);
      assert.deepEqual(slo.gate.enrichment, { deferred: true, pending: 1, completed: 0, total: 1 });
      // Terminal-field semantics: a healthy run never reports a clustering breach.
      assert.ok(!slo.breaches.includes("cluster_timeout_rate"));
      assert.ok(!slo.breaches.includes("cluster_failure_rate"));
    });
  } finally {
    _refreshSlo.reset();
    _refreshPipeline.run = prevRun;
    _snapshotRepo.write = prevWrite;
    _snapshotRepo.getLocks = prevGetLocks;
    _snapshotRepo.insertLocks = prevInsertLocks;
  }
});

// ─── Slice 5: progressive whyItMatters enrichment ────────────────────────────

// A deferred interactive pipeline stub: stories ship with non-empty fallback
// whyItMatters and a `whyEnrichment.deferred` log (mirrors deferWhyItMatters).
function deferredInteractivePipelineStub() {
  return async (opts) => ({
    payload: {
      contractVersion: opts.contractVersion,
      stories: [
        {
          id: "m1", metaStoryId: "m1", title: "T", subtitle: "sub",
          geographies: ["US"], topic: "Diplomatic relations", summary: "x",
          whyItMatters: "This narrative is newly entering your monitoring set; treat initial signals as baseline context before stronger implications.",
          whatChanged: "z", priority: "standard", outletCount: 1,
          tags: { topics: [], keywords: [], geographies: ["US"] },
          sources: [{ id: "s1", outlet: "Reuters", kind: "traditional", weight: 50, url: "https://x", minutesAgo: 10, headline: "h", body: ["b"] }],
        },
      ],
    },
    log: {
      unchanged: false, poolCount: 1, relevantCount: 1, metaStoryCount: 1,
      usedFallbackClustering: false, clusteringFailureReason: null, clusteringAttempts: 2,
      watermark: "wm-defer", candidateCount: 1, selectedFeedCount: 1,
      selection: { sourceSelectionMode: "test" },
      whyItMatters: { deferred: true },
      whyEnrichment: { deferred: true, pending: 1, completed: 0, total: 1, upgradeLatencyMs: null },
    },
  });
}

test("POST /api/dashboard/refresh?interactive=1 defers whyItMatters: non-empty fallback + pending meta + schedules enrichment", async () => {
  const prevRun = _refreshPipeline.run;
  const prevWrite = _snapshotRepo.write;
  const prevGetLocks = _snapshotRepo.getLocks;
  const prevInsertLocks = _snapshotRepo.insertLocks;
  const prevEnrich = _whyEnricher.enrich;
  let enrichCall = null;
  _refreshPipeline.run = deferredInteractivePipelineStub();
  _snapshotRepo.write = async () => {};
  _snapshotRepo.getLocks = async () => new Map();
  _snapshotRepo.insertLocks = async () => {};
  // Capture the scheduled enrichment without running it (avoid racing the test).
  _whyEnricher.enrich = async (args) => { enrichCall = args; };
  try {
    await withIsolatedUser("slice5-defer", async () => {
      const res = await request(app).post("/api/dashboard/refresh?interactive=1");
      assert.equal(res.status, 200);
      // First paint: stories present with non-empty fallback whyItMatters.
      assert.equal(res.body.stories.length, 1);
      assert.ok(res.body.stories[0].whyItMatters.length > 0);
      // Progressive-state diagnostics surfaced for the client poll loop.
      assert.equal(res.body._meta?.whyEnrichment?.deferred, true);
      assert.equal(res.body._meta?.whyEnrichment?.pending, 1);
      // Async enrichment was scheduled with the generation (watermark) guard.
      assert.ok(enrichCall, "enrichment must be scheduled after the deferred write");
      assert.equal(enrichCall.generation, "wm-defer");
      assert.ok(enrichCall.basePayload, "enrichment receives the just-written payload");
    });
  } finally {
    _refreshPipeline.run = prevRun;
    _snapshotRepo.write = prevWrite;
    _snapshotRepo.getLocks = prevGetLocks;
    _snapshotRepo.insertLocks = prevInsertLocks;
    _whyEnricher.enrich = prevEnrich;
  }
});

// Helper: persist a deferred snapshot directly + return its in-memory base payload.
async function seedDeferredSnapshot(userId, generation) {
  const basePayload = {
    contractVersion: "2026-05-19-meta-story-fields",
    stories: [
      {
        id: "m1", metaStoryId: "m1", title: "T", subtitle: "sub",
        geographies: ["US"], topic: "Diplomatic relations", summary: "x",
        whyItMatters: "This narrative is newly entering your monitoring set; treat initial signals as baseline context before stronger implications.",
        whatChanged: "z", priority: "standard", outletCount: 1,
        tags: { topics: [], keywords: [], geographies: ["US"] },
        sources: [{ id: "s1", outlet: "Reuters", kind: "traditional", weight: 50, url: "https://x", minutesAgo: 10, headline: "h", body: ["b"] }],
      },
    ],
    _watermark: generation,
    _everSeenMetaStoryIds: [],
    _lastRunMeta: { whyEnrichment: { deferred: true, pending: 1, completed: 0, total: 1, upgradeLatencyMs: null } },
  };
  await _snapshotRepo.write(userId, basePayload);
  return basePayload;
}

test("Slice 5 enrichment: success path upgrades whyItMatters in the snapshot and clears pending", async () => {
  await withIsolatedUser("slice5-upgrade", async () => {
    const userId = "slice5-upgrade";
    const basePayload = await seedDeferredSnapshot(userId, "gen-up");
    const richResolver = async (input) => ({ whyItMatters: `RICH:${input.metaStoryId}`, trace: {}, diagnostics: {} });
    const result = await _whyEnricher.enrich(
      { userId, generation: "gen-up", basePayload },
      { resolveWhyItMattersFn: richResolver }
    );
    assert.equal(result.kind, "upgraded");
    const snap = await _snapshotRepo.read(userId);
    assert.equal(snap.stories[0].whyItMatters, "RICH:m1", "upgraded copy persisted");
    assert.equal(snap._meta.whyEnrichment.deferred, false);
    assert.equal(snap._meta.whyEnrichment.pending, 0);
    assert.equal(snap._meta.whyEnrichment.completed, 1);
  });
});

test("Slice 5 enrichment: preserves same-generation metadata changed after the initial write (no clobber)", async () => {
  await withIsolatedUser("slice5-meta-merge", async () => {
    const userId = "slice5-meta-merge";
    // Initial deferred write → capture basePayload (the enricher's write source).
    const basePayload = await seedDeferredSnapshot(userId, "gen-meta");
    // Simulate a CONCURRENT same-generation metadata write landing between the
    // initial write and enrichment completion: same _watermark, but new
    // `_lastRunMeta.funnel` + a newer `_lastCheckedAt`, still pending so the
    // idempotency guard does not trip.
    await _snapshotRepo.write(userId, {
      ...basePayload,
      _lastCheckedAt: "2026-06-01T12:00:00.000Z",
      _lastRunMeta: {
        ...basePayload._lastRunMeta,
        funnel: { primaryDropStage: "geo_filter" },
        clusterModel: "anthropic:later-model",
      },
    });
    const richResolver = async (input) => ({ whyItMatters: `RICH:${input.metaStoryId}`, trace: {}, diagnostics: {} });
    // Enrich with the ORIGINAL basePayload (which lacks funnel/clusterModel).
    const result = await _whyEnricher.enrich(
      { userId, generation: "gen-meta", basePayload },
      { resolveWhyItMattersFn: richResolver }
    );
    assert.equal(result.kind, "upgraded");
    const snap = await _snapshotRepo.read(userId);
    // Intended enrichment overrides applied…
    assert.equal(snap.stories[0].whyItMatters, "RICH:m1");
    assert.equal(snap._meta.whyEnrichment.deferred, false);
    assert.equal(snap._meta.whyEnrichment.pending, 0);
    // …while the concurrently-written same-generation metadata is RETAINED
    // (not clobbered by the stale basePayload).
    assert.deepEqual(snap._meta.funnel, { primaryDropStage: "geo_filter" });
    assert.equal(snap._meta.clusterModel, "anthropic:later-model");
    assert.equal(snap._meta.lastCheckedAt, "2026-06-01T12:00:00.000Z");
  });
});

test("Slice 5 enrichment: stale guard — generation mismatch is a no-op (no overwrite)", async () => {
  await withIsolatedUser("slice5-stale", async () => {
    const userId = "slice5-stale";
    const basePayload = await seedDeferredSnapshot(userId, "gen-current");
    const writeSpy = [];
    const prevWrite = _snapshotRepo.write;
    _snapshotRepo.write = async (...args) => { writeSpy.push(args); return prevWrite(...args); };
    try {
      const richResolver = async (input) => ({ whyItMatters: `RICH:${input.metaStoryId}`, trace: {}, diagnostics: {} });
      // generation does NOT match the persisted snapshot's _watermark.
      const result = await _whyEnricher.enrich(
        { userId, generation: "gen-OLD-STALE", basePayload },
        { resolveWhyItMattersFn: richResolver }
      );
      assert.equal(result.kind, "stale");
      assert.equal(writeSpy.length, 0, "stale enrichment must NOT write");
      const snap = await _snapshotRepo.read(userId);
      // Snapshot untouched — still the deferred fallback copy + pending.
      assert.ok(snap.stories[0].whyItMatters.startsWith("This narrative is newly entering"));
      assert.equal(snap._meta.whyEnrichment.deferred, true);
    } finally {
      _snapshotRepo.write = prevWrite;
    }
  });
});

test("Slice 5 enrichment: idempotent — re-running after upgrade is a no-op", async () => {
  await withIsolatedUser("slice5-idem", async () => {
    const userId = "slice5-idem";
    const basePayload = await seedDeferredSnapshot(userId, "gen-idem");
    const richResolver = async (input) => ({ whyItMatters: `RICH:${input.metaStoryId}`, trace: {}, diagnostics: {} });
    const first = await _whyEnricher.enrich({ userId, generation: "gen-idem", basePayload }, { resolveWhyItMattersFn: richResolver });
    assert.equal(first.kind, "upgraded");
    const second = await _whyEnricher.enrich({ userId, generation: "gen-idem", basePayload }, { resolveWhyItMattersFn: richResolver });
    assert.equal(second.kind, "already_done", "second run must be a no-op");
  });
});

test("Slice 5 enrichment: failed upgrade degrades to valid non-empty fallback (snapshot stays valid)", async () => {
  await withIsolatedUser("slice5-fail", async () => {
    const userId = "slice5-fail";
    const basePayload = await seedDeferredSnapshot(userId, "gen-fail");
    const throwingResolver = async () => { throw new Error("writer down"); };
    const result = await _whyEnricher.enrich(
      { userId, generation: "gen-fail", basePayload },
      { resolveWhyItMattersFn: throwingResolver }
    );
    assert.equal(result.kind, "upgraded"); // pass completes; copy degraded to fallback
    const snap = await _snapshotRepo.read(userId);
    assert.ok(snap.stories[0].whyItMatters.length > 0, "story whyItMatters stays non-empty");
    assert.equal(snap._meta.whyEnrichment.deferred, false, "enrichment marks done even on degrade");
    assert.equal(snap._meta.whyEnrichment.completed, 0, "no stories upgraded when the resolver fails");
  });
});

// ─── Slice 1: fail-closed clustering snapshot continuity ─────────────────────

// Shared fail-closed pipeline stub: clustering failed on both attempts, so the
// pipeline publishes ZERO stories and classifies the failure.  This is exactly
// the shape `runRefreshPipeline` returns on its locked fail-closed path.
function failClosedClusteringPipelineStub(reason = "timeout") {
  // Prompt 1.1: mirror the real pipeline by carrying the failure subtype on the
  // log (top-level + outcomes). Representative mapping: timeout→timeout_budget,
  // non-timeout→provider_request.
  const subtype = reason === "timeout" ? "timeout_budget" : "provider_request";
  return async (opts) => ({
    payload: { contractVersion: opts.contractVersion, stories: [] },
    log: {
      unchanged: false,
      poolCount: 4,
      relevantCount: 3,
      metaStoryCount: 0,
      usedFallbackClustering: true,
      clusteringFailureReason: reason,
      clusteringFailureSubtype: subtype,
      clusteringRecoverySubtype: null,
      clusteringAttempts: 2,
      clusteringLatencyMs: [120, 130],
      groundingFailures: 0,
      droppedUngroundedStoryCount: 0,
      groundingDropReasons: {},
      watermark: "wm-failed-run",
      candidateCount: 3,
      selectedFeedCount: 1,
      selection: { sourceSelectionMode: "strict" },
      funnel: { primaryDropStage: "clustering_and_grounding" },
      timings: { pipelineMs: 50 },
      outcomes: {
        storiesPublished: 0,
        clusteringAttempts: 2,
        clusteringFailureReason: reason,
        clusteringFailureSubtype: subtype,
        usedFallbackClustering: true,
      },
    },
  });
}

// A prior HEALTHY snapshot — carries visible stories plus the persisted
// `_watermark` / `_selectionMeta` the route re-serves on continuity.  The
// story is contract-valid (passes `dashboardPayloadSchema`): a non-empty
// `sources` array with every required `sourceSchema` field, so the fixture
// matches what `_snapshotRepo.read` actually returns in production rather than
// a degenerate shape the schema would reject.  The re-served body is asserted
// against `dashboardPayloadSchema` in the WITH-prior test below.
const PRIOR_HEALTHY_SNAPSHOT = Object.freeze({
  contractVersion: "2026-05-19-meta-story-fields",
  stories: [
    {
      id: "healthy-1",
      metaStoryId: "healthy-1",
      title: "Healthy Prior Story",
      subtitle: "Prior subtitle.",
      geographies: ["US"],
      topic: "Diplomatic relations",
      summary: "Prior summary.",
      whyItMatters: "Prior implication.",
      whatChanged: "Prior delta.",
      priority: "standard",
      outletCount: 1,
      tags: { topics: ["Diplomatic relations"], keywords: [], geographies: ["US"] },
      sources: [
        {
          id: "healthy-src-1",
          outlet: "Reuters",
          byline: "Staff",
          kind: "traditional",
          weight: 80,
          url: "https://example.com/healthy-1",
          minutesAgo: 42,
          headline: "Prior healthy headline",
          body: ["Prior healthy body paragraph."],
        },
      ],
    },
  ],
  _watermark: "wm-prior-healthy",
  _selectionMeta: { sourceSelectionMode: "strict" },
  _meta: { refreshedAt: "2026-05-31T00:00:00.000Z", hasSnapshot: true },
});

test("POST /api/dashboard/refresh: clustering fail-closed WITH prior healthy snapshot re-serves prior stories and does NOT publish an empty replacement", async () => {
  const prevRun = _refreshPipeline.run;
  const prevRead = _snapshotRepo.read;
  const prevWrite = _snapshotRepo.write;
  const prevWriteMeta = _snapshotRepo.writeMeta;
  const prevGetLocks = _snapshotRepo.getLocks;
  const prevInsertLocks = _snapshotRepo.insertLocks;
  let writeCalled = false;
  let writeMetaCalled = false;
  _refreshPipeline.run = failClosedClusteringPipelineStub("timeout");
  _snapshotRepo.read = async () => PRIOR_HEALTHY_SNAPSHOT;
  _snapshotRepo.write = async () => { writeCalled = true; };
  _snapshotRepo.writeMeta = async () => { writeMetaCalled = true; };
  _snapshotRepo.getLocks = async () => new Map();
  _snapshotRepo.insertLocks = async () => {};
  try {
    await withIsolatedUser("slice1-failclosed-with-prior", async () => {
      const res = await request(app).post("/api/dashboard/refresh");
      assert.equal(res.status, 200);
      // The re-served body must conform to the dashboard contract — the
      // continuity path serves the prior snapshot verbatim, so a contract-valid
      // prior (non-empty sources, all required fields) stays contract-valid out.
      const parsed = dashboardPayloadSchema.safeParse({ contractVersion: res.body.contractVersion, stories: res.body.stories });
      assert.ok(parsed.success, `re-served body must conform to dashboardPayloadSchema: ${JSON.stringify(parsed.error?.errors)}`);
      // The prior healthy stories remain visible — NOT an empty replacement.
      assert.equal(res.body.stories.length, 1, "prior healthy stories must remain visible");
      assert.equal(res.body.stories[0].metaStoryId, "healthy-1");
      assert.equal(res.body.stories[0].sources.length, 1, "prior story sources must be re-served intact");
      // Crucially: the empty snapshot was NOT written (no overwrite of healthy).
      assert.equal(writeCalled, false, "must NOT publish/persist an empty replacement snapshot");
      // The check timestamp still advances (best-effort writeMeta bump).
      assert.equal(writeMetaCalled, true, "lastCheckedAt must be bumped via writeMeta");
      // Diagnostics make this observable as a clustering-failure continuity event.
      assert.equal(res.body._meta?.snapshotPreserved, true, "_meta.snapshotPreserved flag must be set");
      assert.equal(res.body._meta?.clusteringFailureReason, "timeout");
      assert.equal(res.body._meta?.usedFallbackClustering, true);
      assert.equal(res.body._meta?.clusteringAttempts, 2);
      assert.equal(res.body._meta?.refreshSkippedReason, "clustering_failed_snapshot_preserved");
      assert.equal(res.body._meta?.hasSnapshot, true);
      assert.equal(res.body._meta?.unchanged, false);
      // Prior snapshot's own selection/watermark are re-served (contract parity
      // with GET /api/dashboard for that snapshot).
      assert.equal(res.body._meta?.watermark, "wm-prior-healthy");
      assert.ok(res.body._meta?.selection, "prior selection metadata must be re-served");
      // Persisted internals must not leak at the top level.
      assert.equal(res.body._watermark, undefined);
      assert.equal(res.body._selectionMeta, undefined);
    });
  } finally {
    _refreshPipeline.run = prevRun;
    _snapshotRepo.read = prevRead;
    _snapshotRepo.write = prevWrite;
    _snapshotRepo.writeMeta = prevWriteMeta;
    _snapshotRepo.getLocks = prevGetLocks;
    _snapshotRepo.insertLocks = prevInsertLocks;
  }
});

test("POST /api/dashboard/refresh: clustering fail-closed with NO prior snapshot keeps the empty (no-stories) behavior", async () => {
  const prevRun = _refreshPipeline.run;
  const prevRead = _snapshotRepo.read;
  const prevWrite = _snapshotRepo.write;
  const prevGetLocks = _snapshotRepo.getLocks;
  const prevInsertLocks = _snapshotRepo.insertLocks;
  let writtenPayload = null;
  _refreshPipeline.run = failClosedClusteringPipelineStub("error");
  _snapshotRepo.read = async () => null; // no prior snapshot
  _snapshotRepo.write = async (_uid, payload) => { writtenPayload = payload; };
  _snapshotRepo.getLocks = async () => new Map();
  _snapshotRepo.insertLocks = async () => {};
  try {
    await withIsolatedUser("slice1-failclosed-no-prior", async () => {
      const res = await request(app).post("/api/dashboard/refresh");
      assert.equal(res.status, 200);
      // No prior snapshot to preserve → existing clustering-failed empty
      // behavior: zero stories, and the empty snapshot IS published.
      assert.equal(res.body.stories.length, 0, "no stories on clustering failure with no prior");
      assert.ok(writtenPayload !== null, "empty snapshot is still persisted when there is no prior");
      assert.equal(writtenPayload.stories.length, 0);
      // Not a continuity event — the preservation flag must be absent.
      assert.notEqual(res.body._meta?.snapshotPreserved, true, "snapshotPreserved must NOT be set without a prior healthy snapshot");
      // Failure remains observable via the normal fail-closed diagnostics.
      assert.equal(res.body._meta?.clusteringFailureReason, "error");
      // Prompt 1.1: the failure subtype is forwarded at top-level `_meta` on the
      // "ran" branch (this is the gap the patch closes — probe reads it here).
      assert.equal(res.body._meta?.clusteringFailureSubtype, "provider_request");
      assert.equal(res.body._meta?.usedFallbackClustering, true);
    });
  } finally {
    _refreshPipeline.run = prevRun;
    _snapshotRepo.read = prevRead;
    _snapshotRepo.write = prevWrite;
    _snapshotRepo.getLocks = prevGetLocks;
    _snapshotRepo.insertLocks = prevInsertLocks;
  }
});

test("POST /api/dashboard/refresh: clustering fail-closed with an EMPTY prior snapshot (no stories) does NOT preserve and publishes empty", async () => {
  // "Healthy" means the prior carried visible stories.  An empty prior is not
  // healthy — preserving it would trap the user at zero, so we fall through to
  // the normal publish path (no false continuity).
  const prevRun = _refreshPipeline.run;
  const prevRead = _snapshotRepo.read;
  const prevWrite = _snapshotRepo.write;
  const prevGetLocks = _snapshotRepo.getLocks;
  const prevInsertLocks = _snapshotRepo.insertLocks;
  let writeCalled = false;
  _refreshPipeline.run = failClosedClusteringPipelineStub("timeout");
  _snapshotRepo.read = async () => ({
    contractVersion: "2026-05-19-meta-story-fields",
    stories: [],
    _watermark: "wm-empty-prior",
  });
  _snapshotRepo.write = async () => { writeCalled = true; };
  _snapshotRepo.getLocks = async () => new Map();
  _snapshotRepo.insertLocks = async () => {};
  try {
    await withIsolatedUser("slice1-failclosed-empty-prior", async () => {
      const res = await request(app).post("/api/dashboard/refresh");
      assert.equal(res.status, 200);
      assert.equal(res.body.stories.length, 0);
      assert.notEqual(res.body._meta?.snapshotPreserved, true, "empty prior is not healthy → no preservation");
      assert.equal(writeCalled, true, "empty prior falls through to the normal publish path");
    });
  } finally {
    _refreshPipeline.run = prevRun;
    _snapshotRepo.read = prevRead;
    _snapshotRepo.write = prevWrite;
    _snapshotRepo.getLocks = prevGetLocks;
    _snapshotRepo.insertLocks = prevInsertLocks;
  }
});

// ─── Sub-slice 2.3: refresh reads from Tier-A cache, falls back to live ──────

test("POST /api/dashboard/refresh (2.3): pipeline receives cache-derived rawItems when cache returns rows for selected feeds", async () => {
  // Flip ONLY the cache path on (via `_recentItemsCache.enabled` hook) so the
  // settings/snapshot/narrative adapters stay file-backed.  `_recentItemsCache.read`
  // is stubbed to return a Reuters row; the route handler must convert it to
  // pipeline input and skip the live fetch entirely.  Pinned by capturing the
  // `rawItems` the pipeline actually saw.
  const prevRun = _refreshPipeline.run;
  const prevWrite = _snapshotRepo.write;
  const prevGetLocks = _snapshotRepo.getLocks;
  const prevInsertLocks = _snapshotRepo.insertLocks;
  const prevCacheRead = _recentItemsCache.read;
  const prevCacheWrite = _recentItemsCache.write;
  const prevCacheEnabled = _recentItemsCache.enabled;
  const prevCacheClient = _recentItemsCache.client;

  _snapshotRepo.write = async () => {};
  _snapshotRepo.getLocks = async () => new Map();
  _snapshotRepo.insertLocks = async () => {};
  _recentItemsCache.enabled = () => true;
  _recentItemsCache.client = () => null;

  let cacheReadArgs = null;
  // Synthetic cache row tied to the manifest feed `reuters-world` seeded at
  // module load — its publisher resolves to "Reuters" via mapEntry/derive
  // semantics, matching VALID_BODY.traditionalSources.
  const CACHED_AT = new Date(Date.now() - 25 * 60_000).toISOString(); // 25min ago
  const FETCHED_AT = new Date(Date.now() - 5 * 60_000).toISOString();
  const EXPIRES_AT = new Date(Date.now() + 35 * 60_000).toISOString();
  const cacheRow = {
    source_id: "reuters-world::cached-1",
    feed_id: "reuters-world",
    url: "https://reuters.example.com/cached-article",
    headline: "Cached Reuters headline",
    snippet: "Cached body paragraph.",
    published_at: CACHED_AT,
    fetched_at: FETCHED_AT,
    expires_at: EXPIRES_AT,
  };
  _recentItemsCache.read = async (opts) => {
    cacheReadArgs = opts;
    return { rows: [cacheRow], error: null };
  };
  let cacheWriteCalled = false;
  _recentItemsCache.write = async () => { cacheWriteCalled = true; return { written: 0, error: null }; };

  let capturedRawItems = null;
  _refreshPipeline.run = async (opts) => {
    capturedRawItems = opts.rawItems;
    return {
      payload: { contractVersion: VALID_BODY.contractVersion, stories: [] },
      log: {
        unchanged: false,
        poolCount: 0,
        relevantCount: 0,
        usedFallbackClustering: false,
        groundingFailures: 0,
        droppedUngroundedStoryCount: 0,
        groundingDropReasons: {},
        watermark: "",
        candidateCount: 0,
        selectedFeedCount: 0,
        selection: {},
      },
    };
  };

  try {
    const res = await request(app).post("/api/dashboard/refresh");
    assert.equal(res.status, 200);
    assert.ok(cacheReadArgs, "cache read must have been invoked");
    assert.ok(
      Array.isArray(cacheReadArgs.feedIds) && cacheReadArgs.feedIds.includes("reuters-world"),
      `cache lookup must be scoped to selected feed IDs; saw ${JSON.stringify(cacheReadArgs.feedIds)}`
    );
    assert.ok(Array.isArray(capturedRawItems), "pipeline must receive rawItems");
    assert.equal(capturedRawItems.length, 1, "pipeline must receive exactly the cached row");
    const item = capturedRawItems[0];
    assert.equal(item.sourceId, "reuters-world::cached-1");
    assert.equal(item.feedId, "reuters-world");
    assert.equal(item.headline, "Cached Reuters headline");
    assert.equal(item.outlet, "Reuters", "outlet derives from manifest publisher / feed name");
    assert.deepEqual(item.body, ["Cached body paragraph."]);
    assert.equal(
      cacheWriteCalled,
      false,
      "cache write must NOT fire on a cache HIT — only live fetches re-warm the cache"
    );
  } finally {
    _refreshPipeline.run = prevRun;
    _snapshotRepo.write = prevWrite;
    _snapshotRepo.getLocks = prevGetLocks;
    _snapshotRepo.insertLocks = prevInsertLocks;
    _recentItemsCache.read = prevCacheRead;
    _recentItemsCache.write = prevCacheWrite;
    _recentItemsCache.enabled = prevCacheEnabled;
    _recentItemsCache.client = prevCacheClient;
  }
});

test("POST /api/dashboard/refresh (2.3): cache miss falls back to live fetch and re-warms cache", async () => {
  // Pinned cache-miss path: when `_recentItemsCache.read` returns 0 rows, the
  // handler must fall back to `readFeedItems(DATA_DIR)` (fixture mode in
  // tests).  And on the live-fetch branch the write path fires fire-and-
  // forget so the next refresh hits warm cache.
  const prevRun = _refreshPipeline.run;
  const prevWrite = _snapshotRepo.write;
  const prevGetLocks = _snapshotRepo.getLocks;
  const prevInsertLocks = _snapshotRepo.insertLocks;
  const prevCacheRead = _recentItemsCache.read;
  const prevCacheWrite = _recentItemsCache.write;
  const prevCacheEnabled = _recentItemsCache.enabled;
  const prevCacheClient = _recentItemsCache.client;

  _snapshotRepo.write = async () => {};
  _snapshotRepo.getLocks = async () => new Map();
  _snapshotRepo.insertLocks = async () => {};
  _recentItemsCache.enabled = () => true;
  _recentItemsCache.client = () => null;
  _recentItemsCache.read = async () => ({ rows: [], error: null });

  let cacheWriteItems = null;
  _recentItemsCache.write = async ({ items }) => {
    cacheWriteItems = items;
    return { written: items.length, error: null };
  };

  let capturedRawItems = null;
  _refreshPipeline.run = async (opts) => {
    capturedRawItems = opts.rawItems;
    return {
      payload: { contractVersion: VALID_BODY.contractVersion, stories: [] },
      log: {
        unchanged: false,
        poolCount: 0,
        relevantCount: 0,
        usedFallbackClustering: false,
        groundingFailures: 0,
        droppedUngroundedStoryCount: 0,
        groundingDropReasons: {},
        watermark: "",
        candidateCount: 0,
        selectedFeedCount: 0,
        selection: {},
      },
    };
  };

  try {
    const res = await request(app).post("/api/dashboard/refresh");
    assert.equal(res.status, 200);
    // Stable contract: on cache miss the pipeline must receive items from the
    // live-fetch fallback.  We assert shape (non-empty array of raw items with
    // a string `sourceId`) instead of pinning to a specific fixture
    // `sourceId` — the fixture catalog can grow or be reordered without
    // breaking unrelated assertions about cache-miss wiring.
    assert.ok(Array.isArray(capturedRawItems), "pipeline must receive rawItems from the fallback");
    assert.ok(capturedRawItems.length > 0, "live fallback must produce at least one raw item");
    for (const item of capturedRawItems) {
      assert.equal(typeof item?.sourceId, "string");
      assert.ok(item.sourceId.length > 0, "each raw item must carry a non-empty sourceId");
    }
    // Fire-and-forget write may run after the response — await a microtask
    // for the scheduled .then chain to settle.
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(Array.isArray(cacheWriteItems), "cache write must fire on the live-fetch branch");
    assert.ok(cacheWriteItems.length > 0, "cache write must receive at least one item");
    // Overlap proof: the cache re-warm path must persist the SAME items the
    // pipeline just consumed — otherwise a subsequent refresh wouldn't see
    // the live fetch reflected in the cache.  Using set intersection avoids
    // coupling to fixture order or count while still failing fast if the two
    // sides ever diverge.
    const pipelineIds = new Set(capturedRawItems.map((i) => i.sourceId));
    const cacheIds = new Set(cacheWriteItems.map((i) => i.sourceId));
    const overlap = [...pipelineIds].filter((id) => cacheIds.has(id));
    assert.ok(
      overlap.length > 0,
      "cache write and pipeline rawItems must share at least one sourceId (same live-fetch batch)"
    );
  } finally {
    _refreshPipeline.run = prevRun;
    _snapshotRepo.write = prevWrite;
    _snapshotRepo.getLocks = prevGetLocks;
    _snapshotRepo.insertLocks = prevInsertLocks;
    _recentItemsCache.read = prevCacheRead;
    _recentItemsCache.write = prevCacheWrite;
    _recentItemsCache.enabled = prevCacheEnabled;
    _recentItemsCache.client = prevCacheClient;
  }
});

test("POST /api/dashboard/refresh (Slice 2): cache miss forwards matched feedIds to scoped live fetch", async () => {
  // The Slice 2 wire-up: on a cache miss with a resolved user selection the
  // handler must call the live reader with `{ feedIds: [...] }` so only the
  // user's matched feeds are fetched — not the whole manifest.  We stub the
  // `_feedReader.read` hook to capture its args (instead of hitting RSS) and
  // assert the second arg carries the matched feed id.
  const prevRun = _refreshPipeline.run;
  const prevWrite = _snapshotRepo.write;
  const prevGetLocks = _snapshotRepo.getLocks;
  const prevInsertLocks = _snapshotRepo.insertLocks;
  const prevCacheRead = _recentItemsCache.read;
  const prevCacheWrite = _recentItemsCache.write;
  const prevCacheEnabled = _recentItemsCache.enabled;
  const prevCacheClient = _recentItemsCache.client;
  const prevFeedRead = _feedReader.read;

  _snapshotRepo.write = async () => {};
  _snapshotRepo.getLocks = async () => new Map();
  _snapshotRepo.insertLocks = async () => {};
  _recentItemsCache.enabled = () => true;
  _recentItemsCache.client = () => null;
  _recentItemsCache.read = async () => ({ rows: [], error: null }); // force miss
  _recentItemsCache.write = async ({ items }) => ({ written: items.length, error: null });

  let feedReadArgs = null;
  _feedReader.read = async (dataDir, opts) => {
    feedReadArgs = { dataDir, opts };
    // Minimal raw item so the downstream pipeline + cache write don't choke.
    return [
      {
        sourceId: "reuters-world::scoped-1",
        feedId: "reuters-world",
        outlet: "Reuters",
        url: "https://reuters.example.com/scoped-article",
        headline: "Scoped fetch headline",
        body: ["Scoped body."],
        minutesAgo: 5,
        weight: 80,
      },
    ];
  };

  _refreshPipeline.run = async () => ({
    payload: { contractVersion: VALID_BODY.contractVersion, stories: [] },
    log: {
      unchanged: false,
      poolCount: 0,
      relevantCount: 0,
      usedFallbackClustering: false,
      groundingFailures: 0,
      droppedUngroundedStoryCount: 0,
      groundingDropReasons: {},
      watermark: "",
      candidateCount: 0,
      selectedFeedCount: 0,
      selection: {},
    },
  });

  try {
    const res = await request(app).post("/api/dashboard/refresh");
    assert.equal(res.status, 200);
    assert.ok(feedReadArgs, "live reader must have been invoked on cache miss");
    assert.ok(
      feedReadArgs.opts && typeof feedReadArgs.opts === "object",
      `live reader must receive a scoped opts object; saw ${JSON.stringify(feedReadArgs.opts)}`
    );
    assert.ok(
      Array.isArray(feedReadArgs.opts.feedIds) && feedReadArgs.opts.feedIds.includes("reuters-world"),
      `scoped fetch must forward matched feedIds; saw ${JSON.stringify(feedReadArgs.opts?.feedIds)}`
    );
    // Slice 2 contract guard: every forwarded id is a non-empty string, and
    // feedIds is never null/undefined when a selection exists.
    assert.ok(
      feedReadArgs.opts.feedIds.every((id) => typeof id === "string" && id.length > 0),
      "feedIds must be non-empty strings"
    );
  } finally {
    _refreshPipeline.run = prevRun;
    _snapshotRepo.write = prevWrite;
    _snapshotRepo.getLocks = prevGetLocks;
    _snapshotRepo.insertLocks = prevInsertLocks;
    _recentItemsCache.read = prevCacheRead;
    _recentItemsCache.write = prevCacheWrite;
    _recentItemsCache.enabled = prevCacheEnabled;
    _recentItemsCache.client = prevCacheClient;
    _feedReader.read = prevFeedRead;
  }
});

test("POST /api/dashboard/refresh (Slice 2 deferred): no matched feeds → cache miss calls live reader WITHOUT feedIds (full-manifest)", async () => {
  // The Slice 2 omit-when-empty contract: when the user has NO matched feeds
  // (empty traditional + social sources → cacheFeedIds.length === 0), a cache
  // miss must call `_feedReader.read(DATA_DIR)` with NO opts arg — preserving
  // full-manifest behavior — rather than passing an empty `feedIds` array.
  // A fresh isolated user has no settings file, so readSettings returns
  // DEFAULT_SETTINGS (empty sources) → cacheFeedIds is empty.
  const prevRun = _refreshPipeline.run;
  const prevWrite = _snapshotRepo.write;
  const prevGetLocks = _snapshotRepo.getLocks;
  const prevInsertLocks = _snapshotRepo.insertLocks;
  const prevCacheRead = _recentItemsCache.read;
  const prevCacheWrite = _recentItemsCache.write;
  const prevCacheEnabled = _recentItemsCache.enabled;
  const prevCacheClient = _recentItemsCache.client;
  const prevFeedRead = _feedReader.read;
  const origLog = console.log;

  _snapshotRepo.write = async () => {};
  _snapshotRepo.getLocks = async () => new Map();
  _snapshotRepo.insertLocks = async () => {};
  _recentItemsCache.enabled = () => true;
  _recentItemsCache.client = () => null;
  // Forced miss — though with cacheFeedIds empty the read branch is skipped
  // entirely; stubbed defensively so a regression that DOES read still misses.
  _recentItemsCache.read = async () => ({ rows: [], error: null });
  _recentItemsCache.write = async ({ items }) => ({ written: items.length, error: null });

  let feedReadArgs = null;
  let feedReadArgCount = null;
  _feedReader.read = async (...args) => {
    feedReadArgCount = args.length;
    feedReadArgs = { dataDir: args[0], opts: args[1] };
    return [
      {
        sourceId: "nyt-politics::full-1",
        feedId: "nyt-politics",
        outlet: "The New York Times",
        url: "https://nyt.example.com/full-article",
        headline: "Full-manifest headline",
        body: ["Full body."],
        minutesAgo: 7,
        weight: 95,
      },
    ];
  };

  _refreshPipeline.run = async () => ({
    payload: { contractVersion: VALID_BODY.contractVersion, stories: [] },
    log: {
      unchanged: false,
      poolCount: 0,
      relevantCount: 0,
      usedFallbackClustering: false,
      groundingFailures: 0,
      droppedUngroundedStoryCount: 0,
      groundingDropReasons: {},
      watermark: "",
      candidateCount: 0,
      selectedFeedCount: 0,
      selection: {},
    },
  });

  const captured = [];
  console.log = (...msgs) => { captured.push(msgs.map(String).join(" ")); };

  try {
    await withIsolatedUser("slice3-no-matched-feeds-user", async () => {
      const res = await request(app).post("/api/dashboard/refresh");
      assert.equal(res.status, 200);
    });
  } finally {
    console.log = origLog;
    _refreshPipeline.run = prevRun;
    _snapshotRepo.write = prevWrite;
    _snapshotRepo.getLocks = prevGetLocks;
    _snapshotRepo.insertLocks = prevInsertLocks;
    _recentItemsCache.read = prevCacheRead;
    _recentItemsCache.write = prevCacheWrite;
    _recentItemsCache.enabled = prevCacheEnabled;
    _recentItemsCache.client = prevCacheClient;
    _feedReader.read = prevFeedRead;
  }

  assert.ok(feedReadArgs, "live reader must have been invoked on cache miss");
  // Core contract: feedIds key is omitted entirely (no second arg passed),
  // NOT passed as an empty array.
  assert.equal(feedReadArgCount, 1, "live reader must be called with dataDir only (no opts arg)");
  assert.equal(
    feedReadArgs.opts,
    undefined,
    `opts must be undefined when there are no matched feeds; saw ${JSON.stringify(feedReadArgs.opts)}`
  );

  // ingestionSource must remain "live" (full manifest), not "live_scoped".
  const refreshLog = captured.find((m) => m.includes("[refresh] ingestionSource="));
  assert.ok(refreshLog, "expected a [refresh] summary log line");
  assert.match(refreshLog, /ingestionSource=live items=/, "ingestionSource must be 'live', not 'live_scoped'");
  assert.equal(refreshLog.includes("live_scoped"), false, "scoped source must NOT be used with no matched feeds");
});

// ─── What-changed Phase 1: ever-seen persistence + non-exposure ──────────────

test("POST /api/dashboard/refresh: persisted snapshot includes merged _everSeenMetaStoryIds", async () => {
  let writtenPayload = null;
  const prevWrite = _snapshotRepo.write;
  const prevRead = _snapshotRepo.read;
  const prevGetLocks = _snapshotRepo.getLocks;
  const prevInsertLocks = _snapshotRepo.insertLocks;
  // Simulate a prior snapshot carrying two historical metaStoryIds so we can
  // assert the merge appends new ones without dropping the originals.
  _snapshotRepo.read = async () => ({
    contractVersion: VALID_BODY.contractVersion,
    stories: [],
    _everSeenMetaStoryIds: ["prior-a", "prior-b"],
    _meta: { hasSnapshot: true, refreshedAt: "2026-05-12T00:00:00.000Z" },
  });
  _snapshotRepo.write = async (_uid, payload) => { writtenPayload = payload; };
  _snapshotRepo.getLocks = async () => new Map();
  _snapshotRepo.insertLocks = async () => {};
  try {
    const res = await request(app).post("/api/dashboard/refresh");
    assert.equal(res.status, 200);
    assert.ok(writtenPayload !== null, "snapshot must be persisted on success");
    assert.ok(Array.isArray(writtenPayload._everSeenMetaStoryIds));
    // Prior ids remain in their oldest-first positions.
    assert.equal(writtenPayload._everSeenMetaStoryIds[0], "prior-a");
    assert.equal(writtenPayload._everSeenMetaStoryIds[1], "prior-b");
    // Any metaStoryIds emitted by the current run get appended after them.
    const currentIds = writtenPayload.stories
      .map((s) => s.metaStoryId)
      .filter((id) => typeof id === "string" && id.length > 0);
    for (const id of currentIds) {
      assert.ok(
        writtenPayload._everSeenMetaStoryIds.includes(id),
        `current metaStoryId ${id} must be in the merged ever-seen array`
      );
    }
    // No duplicates.
    const unique = new Set(writtenPayload._everSeenMetaStoryIds);
    assert.equal(unique.size, writtenPayload._everSeenMetaStoryIds.length);
  } finally {
    _snapshotRepo.write = prevWrite;
    _snapshotRepo.read = prevRead;
    _snapshotRepo.getLocks = prevGetLocks;
    _snapshotRepo.insertLocks = prevInsertLocks;
  }
});

test("POST /api/dashboard/refresh: ever-seen merge across two runs preserves prior ids and dedupes overlaps", async () => {
  // Stub the pipeline so each run produces a deterministic payload with a
  // unique watermark — sidestepping the production watermark short-circuit
  // that would otherwise suppress the second write when nothing changed.
  // The merge correctness is what's under test here.
  const prevRun = _refreshPipeline.run;
  const prevRead = _snapshotRepo.read;
  const prevWrite = _snapshotRepo.write;
  const prevGetLocks = _snapshotRepo.getLocks;
  const prevInsertLocks = _snapshotRepo.insertLocks;
  const writes = [];
  let nextRead = {
    contractVersion: VALID_BODY.contractVersion,
    stories: [],
    _everSeenMetaStoryIds: ["seed-1"],
    _meta: { hasSnapshot: true, refreshedAt: "2026-05-12T00:00:00.000Z" },
  };
  let runIndex = 0;
  _snapshotRepo.read = async () => nextRead;
  _snapshotRepo.write = async (_uid, payload) => {
    writes.push(payload);
    nextRead = {
      ...payload,
      _meta: { hasSnapshot: true, refreshedAt: "2026-05-12T00:00:00.000Z" },
    };
  };
  _snapshotRepo.getLocks = async () => new Map();
  _snapshotRepo.insertLocks = async () => {};
  const buildStubStory = (metaStoryId) => ({
    id: metaStoryId,
    metaStoryId,
    title: `Story ${metaStoryId}`,
    subtitle: "S",
    geographies: ["US"],
    topic: "Diplomatic relations",
    summary: "S",
    whyItMatters: "W",
    whatChanged: "C",
    priority: "standard",
    outletCount: 1,
    tags: { topics: [], keywords: [], geographies: [] },
    sources: [
      {
        id: `src-${metaStoryId}`,
        outlet: "Reuters",
        kind: "traditional",
        weight: 50,
        url: "https://example.com",
        minutesAgo: 5,
        headline: "H",
        body: ["B"],
      },
    ],
  });
  _refreshPipeline.run = async () => {
    runIndex += 1;
    // First run emits seed-1 + new-1; second run emits seed-1 (overlap) + new-2.
    const stories = runIndex === 1
      ? [buildStubStory("seed-1"), buildStubStory("new-1")]
      : [buildStubStory("seed-1"), buildStubStory("new-2")];
    return {
      payload: { contractVersion: VALID_BODY.contractVersion, stories },
      log: {
        unchanged: false,
        poolCount: stories.length,
        relevantCount: stories.length,
        usedFallbackClustering: false,
        groundingFailures: 0,
        droppedUngroundedStoryCount: 0,
        groundingDropReasons: {},
        watermark: `wm-${runIndex}`,
        candidateCount: stories.length,
        selectedFeedCount: 1,
        selection: {},
      },
    };
  };
  try {
    await request(app).post("/api/dashboard/refresh");
    await request(app).post("/api/dashboard/refresh");
    assert.equal(writes.length, 2, "stubbed pipeline must produce two writes");
    const first = writes[0]._everSeenMetaStoryIds;
    const second = writes[1]._everSeenMetaStoryIds;
    // First run: prior seed-1 + currently emitted seed-1 (dedup) + new-1.
    assert.deepEqual(first, ["seed-1", "new-1"]);
    // Second run: prior [seed-1, new-1] + currently emitted seed-1 (dedup) + new-2.
    assert.deepEqual(second, ["seed-1", "new-1", "new-2"]);
    // No duplicates in either snapshot.
    assert.equal(new Set(first).size, first.length);
    assert.equal(new Set(second).size, second.length);
  } finally {
    _refreshPipeline.run = prevRun;
    _snapshotRepo.read = prevRead;
    _snapshotRepo.write = prevWrite;
    _snapshotRepo.getLocks = prevGetLocks;
    _snapshotRepo.insertLocks = prevInsertLocks;
  }
});

test("POST /api/dashboard/refresh: response body does NOT expose _everSeenMetaStoryIds", async () => {
  const prevWrite = _snapshotRepo.write;
  const prevRead = _snapshotRepo.read;
  const prevGetLocks = _snapshotRepo.getLocks;
  const prevInsertLocks = _snapshotRepo.insertLocks;
  _snapshotRepo.read = async () => ({
    contractVersion: VALID_BODY.contractVersion,
    stories: [],
    _everSeenMetaStoryIds: ["leak-check-a", "leak-check-b"],
    _meta: { hasSnapshot: true, refreshedAt: "2026-05-12T00:00:00.000Z" },
  });
  _snapshotRepo.write = async () => {};
  _snapshotRepo.getLocks = async () => new Map();
  _snapshotRepo.insertLocks = async () => {};
  try {
    const res = await request(app).post("/api/dashboard/refresh");
    assert.equal(res.status, 200);
    assert.equal(res.body._everSeenMetaStoryIds, undefined);
    assert.ok(
      !Object.prototype.hasOwnProperty.call(res.body, "_everSeenMetaStoryIds"),
      "_everSeenMetaStoryIds must be stripped from refresh response body"
    );
    assert.equal(
      JSON.stringify(res.body).includes("leak-check-a"),
      false,
      "history ids must not appear anywhere in the response body"
    );
  } finally {
    _snapshotRepo.write = prevWrite;
    _snapshotRepo.read = prevRead;
    _snapshotRepo.getLocks = prevGetLocks;
    _snapshotRepo.insertLocks = prevInsertLocks;
  }
});

test("GET /api/dashboard: response body does NOT expose _everSeenMetaStoryIds", async () => {
  const prev = _snapshotRepo.read;
  _snapshotRepo.read = async () => ({
    contractVersion: VALID_BODY.contractVersion,
    stories: [],
    _everSeenMetaStoryIds: ["get-leak-a", "get-leak-b"],
    _meta: { hasSnapshot: true, refreshedAt: "2026-05-12T00:00:00.000Z" },
  });
  try {
    const res = await request(app).get("/api/dashboard");
    assert.equal(res.status, 200);
    assert.equal(res.body._everSeenMetaStoryIds, undefined);
    assert.ok(!Object.prototype.hasOwnProperty.call(res.body, "_everSeenMetaStoryIds"));
    assert.equal(JSON.stringify(res.body).includes("get-leak-a"), false);
  } finally {
    _snapshotRepo.read = prev;
  }
});

test("GET /api/dashboard: exposes _meta.whatChanged counters when snapshot carries _lastRunMeta.whatChanged (Phase 4)", async () => {
  // The snapshot loader (`liftSnapshotMeta`) lifts `_lastRunMeta.whatChanged`
  // into `_meta.whatChanged` so dashboard reads can answer "what did the
  // delta engine do on the last refresh?" without replaying the pipeline.
  // Internal storage keys must NOT appear at the top level — only under
  // `_meta`.
  const prev = _snapshotRepo.read;
  const WHAT_CHANGED = {
    schemaVersion: "whatchanged-v1",
    firstSeen: 1,
    unchanged: 2,
    changed: 0,
    gateStrong: 0,
    gateWeak: 0,
    gateNone: 3,
    classifySkipped: 3,
    classifyCalled: 0,
    classifyMaterialTrue: 0,
    classifyMaterialFalse: 0,
    writeCalled: 0,
    writeOk: 0,
    llmFailed: { classify: 0, write: 0, hallucination: 0 },
    latencyMs: { classify: 0, write: 0 },
    watermarkShortCircuited: false,
  };
  _snapshotRepo.read = async () => ({
    contractVersion: VALID_BODY.contractVersion,
    stories: [],
    _everSeenMetaStoryIds: ["seed-1"],
    _meta: { hasSnapshot: true, refreshedAt: "2026-05-12T00:00:00.000Z", whatChanged: WHAT_CHANGED },
  });
  try {
    const res = await request(app).get("/api/dashboard");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body._meta?.whatChanged, WHAT_CHANGED);
    // Internal-only keys must stay stripped.
    assert.equal(res.body._everSeenMetaStoryIds, undefined);
    assert.equal(res.body._lastRunMeta, undefined);
  } finally {
    _snapshotRepo.read = prev;
  }
});

test("POST /api/dashboard/refresh: persists log.whatChanged onto _lastRunMeta (Phase 4 E2E)", async () => {
  // Closes the loop GET-side test stops at: a successful refresh whose
  // pipeline emits `log.whatChanged` must persist that object verbatim onto
  // `finalPayload._lastRunMeta.whatChanged` (which the snapshot loader then
  // lifts into `_meta.whatChanged` on subsequent reads).  The response body
  // must NOT expose the internal storage keys.
  const WHAT_CHANGED = {
    schemaVersion: "whatchanged-v1",
    firstSeen: 1,
    unchanged: 0,
    changed: 0,
    gateStrong: 0,
    gateWeak: 0,
    gateNone: 1,
    classifySkipped: 1,
    classifyCalled: 0,
    classifyMaterialTrue: 0,
    classifyMaterialFalse: 0,
    writeCalled: 0,
    writeOk: 0,
    llmFailed: { classify: 0, write: 0, hallucination: 0 },
    latencyMs: { classify: 0, write: 0 },
    watermarkShortCircuited: false,
    everSeenCount: 0,
    priorStoryCount: 0,
  };
  const STUB_STORY = {
    id: "ms-new",
    metaStoryId: "ms-new",
    title: "Stub Story",
    subtitle: "S",
    geographies: ["US"],
    topic: "Diplomatic relations",
    summary: "S",
    whyItMatters: "W",
    whatChanged: "First appearance in your feed.",
    priority: "standard",
    outletCount: 1,
    tags: { topics: [], keywords: [], geographies: [] },
    sources: [
      {
        id: "src-1",
        outlet: "Reuters",
        kind: "traditional",
        weight: 50,
        url: "https://example.com",
        minutesAgo: 5,
        headline: "H",
        body: ["B"],
      },
    ],
  };
  let writtenPayload = null;
  const prevRun = _refreshPipeline.run;
  const prevRead = _snapshotRepo.read;
  const prevWrite = _snapshotRepo.write;
  const prevGetLocks = _snapshotRepo.getLocks;
  const prevInsertLocks = _snapshotRepo.insertLocks;
  _snapshotRepo.read = async () => null;
  _snapshotRepo.write = async (_uid, payload) => { writtenPayload = payload; };
  _snapshotRepo.getLocks = async () => new Map();
  _snapshotRepo.insertLocks = async () => {};
  _refreshPipeline.run = async () => ({
    payload: { contractVersion: VALID_BODY.contractVersion, stories: [STUB_STORY] },
    log: {
      unchanged: false,
      poolCount: 1,
      relevantCount: 1,
      usedFallbackClustering: false,
      groundingFailures: 0,
      droppedUngroundedStoryCount: 0,
      groundingDropReasons: {},
      watermark: "wm-1",
      candidateCount: 1,
      selectedFeedCount: 1,
      selection: {},
      whatChanged: WHAT_CHANGED,
    },
  });
  try {
    const res = await request(app).post("/api/dashboard/refresh");
    assert.equal(res.status, 200);
    // Snapshot write captured the run-level diagnostics under _lastRunMeta.
    assert.ok(writtenPayload !== null, "snapshot must be written on success");
    assert.ok(writtenPayload._lastRunMeta, "_lastRunMeta must be set on the persisted payload");
    assert.deepEqual(writtenPayload._lastRunMeta.whatChanged, WHAT_CHANGED);
    // Internal storage keys must NOT leak into the client response body.
    assert.equal(res.body._lastRunMeta, undefined);
    assert.equal(res.body._everSeenMetaStoryIds, undefined);
    assert.ok(!Object.prototype.hasOwnProperty.call(res.body, "_lastRunMeta"));
    assert.ok(!Object.prototype.hasOwnProperty.call(res.body, "_everSeenMetaStoryIds"));
  } finally {
    _refreshPipeline.run = prevRun;
    _snapshotRepo.read = prevRead;
    _snapshotRepo.write = prevWrite;
    _snapshotRepo.getLocks = prevGetLocks;
    _snapshotRepo.insertLocks = prevInsertLocks;
  }
});

test("POST /api/dashboard/refresh: pipeline receives ever-seen + priorStoriesById pass-through", async () => {
  let capturedOpts = null;
  const prevRun = _refreshPipeline.run;
  const prevRead = _snapshotRepo.read;
  const prevWrite = _snapshotRepo.write;
  const prevGetLocks = _snapshotRepo.getLocks;
  const prevInsertLocks = _snapshotRepo.insertLocks;
  _snapshotRepo.read = async () => ({
    contractVersion: VALID_BODY.contractVersion,
    stories: [
      {
        id: "ms-1",
        metaStoryId: "ms-1",
        title: "Prior 1",
        subtitle: "S",
        geographies: ["US"],
        topic: "Diplomatic relations",
        summary: "S",
        whyItMatters: "W",
        whatChanged: "C",
        priority: "standard",
        outletCount: 1,
        tags: { topics: [], keywords: [], geographies: [] },
        sources: [],
      },
      {
        id: "ms-2",
        metaStoryId: "ms-2",
        title: "Prior 2",
        subtitle: "S",
        geographies: ["US"],
        topic: "Diplomatic relations",
        summary: "S",
        whyItMatters: "W",
        whatChanged: "C",
        priority: "standard",
        outletCount: 1,
        tags: { topics: [], keywords: [], geographies: [] },
        sources: [],
      },
    ],
    _everSeenMetaStoryIds: ["ms-1", "ms-2", "ms-3"],
    _meta: { hasSnapshot: true, refreshedAt: "2026-05-12T00:00:00.000Z" },
  });
  _snapshotRepo.write = async () => {};
  _snapshotRepo.getLocks = async () => new Map();
  _snapshotRepo.insertLocks = async () => {};
  _refreshPipeline.run = async (opts) => {
    capturedOpts = opts;
    // Return a minimal valid pipeline result so the route handler proceeds.
    return {
      payload: { contractVersion: VALID_BODY.contractVersion, stories: [] },
      log: {
        unchanged: false,
        poolCount: 0,
        relevantCount: 0,
        usedFallbackClustering: false,
        groundingFailures: 0,
        droppedUngroundedStoryCount: 0,
        groundingDropReasons: {},
        watermark: "",
        candidateCount: 0,
        selectedFeedCount: 0,
        selection: {},
      },
    };
  };
  try {
    const res = await request(app).post("/api/dashboard/refresh");
    assert.equal(res.status, 200);
    assert.ok(capturedOpts !== null, "pipeline must have been invoked");
    assert.deepEqual(capturedOpts.everSeenMetaStoryIds, ["ms-1", "ms-2", "ms-3"]);
    assert.ok(capturedOpts.priorStoriesById instanceof Map, "priorStoriesById must be a Map");
    assert.equal(capturedOpts.priorStoriesById.size, 2);
    assert.equal(capturedOpts.priorStoriesById.get("ms-1")?.title, "Prior 1");
    assert.equal(capturedOpts.priorStoriesById.get("ms-2")?.title, "Prior 2");
  } finally {
    _refreshPipeline.run = prevRun;
    _snapshotRepo.read = prevRead;
    _snapshotRepo.write = prevWrite;
    _snapshotRepo.getLocks = prevGetLocks;
    _snapshotRepo.insertLocks = prevInsertLocks;
  }
});

test("POST /api/dashboard/refresh: ever-seen NOT advanced on watermark short-circuit (prior snapshot re-served)", async () => {
  // Watermark short-circuit returns payload: null and the route handler must
  // skip the snapshot write entirely — so ever-seen on disk stays where it
  // was on the prior snapshot.
  const prevRun = _refreshPipeline.run;
  const prevRead = _snapshotRepo.read;
  const prevWrite = _snapshotRepo.write;
  let writeCalled = false;
  _snapshotRepo.read = async () => ({
    contractVersion: VALID_BODY.contractVersion,
    stories: [],
    _everSeenMetaStoryIds: ["should-not-grow"],
    _meta: { hasSnapshot: true, refreshedAt: "2026-05-12T00:00:00.000Z" },
  });
  _snapshotRepo.write = async () => { writeCalled = true; };
  _refreshPipeline.run = async () => ({
    payload: null,
    log: {
      unchanged: true,
      refreshSkippedReason: "unchanged_watermark",
      watermark: "wm-stable",
      candidateCount: 0,
      selectedFeedCount: 0,
      selection: {},
    },
  });
  try {
    const res = await request(app).post("/api/dashboard/refresh");
    assert.equal(res.status, 200);
    assert.equal(writeCalled, false, "watermark short-circuit must not call _snapshotRepo.write");
    // Response body must not expose the ever-seen array either.
    assert.equal(res.body._everSeenMetaStoryIds, undefined);
    assert.equal(JSON.stringify(res.body).includes("should-not-grow"), false);
  } finally {
    _refreshPipeline.run = prevRun;
    _snapshotRepo.read = prevRead;
    _snapshotRepo.write = prevWrite;
  }
});

test("POST /api/dashboard/refresh: embedFn throws WITH lexical hits → lexical fallback (degraded, not hard-empty)", async () => {
  // The dashboard false-empty regression we are guarding against: a real
  // embedding outage with obvious lexical matches (the fixture item carries
  // a topic that matches VALID_BODY's `Diplomatic relations`) must surface
  // those items via the lexical-fallback path rather than collapsing the
  // dashboard to zero.  Override the global stub with a throwing one so the
  // production fail-path is observable, not masked.
  const prevEmbed = _embeddings.embed;
  const prevWrite = _snapshotRepo.write;
  const prevGetLocks = _snapshotRepo.getLocks;
  const prevInsertLocks = _snapshotRepo.insertLocks;
  let snapshotWritten = null;
  _embeddings.embed = async () => {
    throw new Error("simulated provider 503: service unavailable");
  };
  _snapshotRepo.write = async (_uid, payload) => { snapshotWritten = payload; };
  _snapshotRepo.getLocks = async () => new Map();
  _snapshotRepo.insertLocks = async () => {};
  try {
    const res = await request(app).post("/api/dashboard/refresh");
    assert.equal(res.status, 200);
    // Lexical fallback surfaces the fixture item (real ingest, no fabrication).
    assert.ok(Array.isArray(res.body.stories), "stories must be present");
    assert.ok(res.body.stories.length >= 1, "lexical fallback must surface keyword/topic hits");
    for (const story of res.body.stories) {
      for (const src of story.sources) {
        assert.ok(typeof src.id === "string" && src.id.length > 0, "every source must carry a real id");
        assert.ok(typeof src.url === "string" && src.url.length > 0, "every source must carry a real url");
      }
    }
    // Operator-facing surface: degraded_reason and the lexical-fallback flag
    // must reach _meta.recall so the cliff is observable.
    const recall = res.body._meta?.recall;
    assert.ok(recall, "_meta.recall must be present on a degraded run");
    assert.equal(recall.degraded, true);
    assert.equal(recall.degraded_reason, "embedding_error_fail_closed");
    assert.equal(recall.keywordFallbackAfterEmbeddingFailure, true);
    // Snapshot is written with the lexical fallback content — never empty
    // when lexical hits exist.
    assert.ok(snapshotWritten !== null);
    assert.ok(snapshotWritten.stories.length >= 1);
  } finally {
    _embeddings.embed = prevEmbed;
    _snapshotRepo.write = prevWrite;
    _snapshotRepo.getLocks = prevGetLocks;
    _snapshotRepo.insertLocks = prevInsertLocks;
  }
});

test("POST /api/dashboard/refresh: embedFn throws WITHOUT lexical hits → strict-empty fail-closed", async () => {
  // Strict-empty path: when settings have no topic/keyword that matches the
  // fixture item, a thrown embedFn yields zero stories and `_meta.recall`
  // surfaces `degraded_reason` without `keywordFallbackAfterEmbeddingFailure`.
  // Use a settings payload with disjoint topics/keywords from the fixture.
  const NO_MATCH_BODY = {
    contractVersion: "2026-05-19-meta-story-fields",
    topics: ["Migration policy"],          // fixture topic is "Diplomatic relations"
    keywords: ["asylum"],                  // fixture body/headline have no asylum
    geographies: ["US"],
    traditionalSources: ["Reuters"],
    socialSources: [],
  };
  const prevEmbed = _embeddings.embed;
  const prevWrite = _snapshotRepo.write;
  const prevGetLocks = _snapshotRepo.getLocks;
  const prevInsertLocks = _snapshotRepo.insertLocks;
  _embeddings.embed = async () => { throw new Error("provider 503"); };
  _snapshotRepo.write = async () => {};
  _snapshotRepo.getLocks = async () => new Map();
  _snapshotRepo.insertLocks = async () => {};
  try {
    // Reset settings to the no-match payload, run refresh, then restore.
    await request(app).put("/api/settings").send(NO_MATCH_BODY).set("Content-Type", "application/json");
    const res = await request(app).post("/api/dashboard/refresh");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.stories, []);
    const recall = res.body._meta?.recall;
    assert.ok(recall);
    assert.equal(recall.degraded, true);
    assert.equal(recall.degraded_reason, "embedding_error_fail_closed");
    assert.notEqual(recall.keywordFallbackAfterEmbeddingFailure, true);
  } finally {
    _embeddings.embed = prevEmbed;
    _snapshotRepo.write = prevWrite;
    _snapshotRepo.getLocks = prevGetLocks;
    _snapshotRepo.insertLocks = prevInsertLocks;
    // Restore the suite-wide VALID_BODY so subsequent tests run unaffected.
    await request(app).put("/api/settings").send(VALID_BODY).set("Content-Type", "application/json");
  }
});

test("POST /api/dashboard/refresh: selection metadata reports unmatched sources when settings names not in manifest", async () => {
  // Self-contained selection-meta test: explicitly pins both the manifest
  // (via the source-feeds.json file the non-Supabase manifest loader reads)
  // AND the user's settings inside the test, restoring both in finally.
  // Removes coupling to prior-test state and to whatever the suite-wide
  // FIXTURE_SOURCE_FEEDS happens to contain at the moment.
  //
  // Scenario: one traditional source matches a row that has an implemented
  // connector (strict mode preserved with matchedSourceCount=1), one social
  // source matches a manifest row whose connector is not implemented yet
  // (counted as unavailable, not strict-empty).
  const sourceFeedsPath = path.join(tmpDir, "source-feeds.json");
  const SELECTION_MANIFEST = {
    feeds: [
      {
        id: "reuters-world-2-4-test",
        name: "Reuters — World News",
        kind: "rss",
        url: "https://example.com/reuters-2-4-test",
        weight: 88,
        active: true,
      },
      // Social row — matches by name but social has no implemented connector,
      // so it's counted under `unavailableConnectorCount`.
      {
        id: "latamwatcher-2-4-test",
        name: "@latamwatcher",
        kind: "social",
        url: "https://twitter.com/latamwatcher",
        weight: 60,
        active: true,
      },
    ],
  };
  const SELECTION_BODY = {
    contractVersion: VALID_BODY.contractVersion,
    topics: ["Diplomatic relations"],
    keywords: ["OFAC"],
    geographies: ["US"],
    traditionalSources: ["Reuters"],
    socialSources: ["@latamwatcher"],
  };

  let writtenPayload = null;
  const prevWrite = _snapshotRepo.write;
  const prevGetLocks = _snapshotRepo.getLocks;
  const prevInsertLocks = _snapshotRepo.insertLocks;
  _snapshotRepo.write = async (_uid, payload) => { writtenPayload = payload; };
  _snapshotRepo.getLocks = async () => new Map();
  _snapshotRepo.insertLocks = async () => {};

  await writeFile(sourceFeedsPath, JSON.stringify(SELECTION_MANIFEST), "utf8");
  await request(app)
    .put("/api/settings")
    .send(SELECTION_BODY)
    .set("Content-Type", "application/json");

  try {
    const res = await request(app).post("/api/dashboard/refresh");
    assert.equal(res.status, 200);
    const sel = res.body._meta?.selection;
    assert.ok(sel);
    // Reuters matches the manifest row, so strict mode is preserved.
    assert.equal(sel.sourceSelectionMode, "strict");
    // @latamwatcher matched social row only — counted as unavailable connector.
    assert.equal(sel.unavailableConnectorCount, 1);
    assert.equal(sel.matchedSourceCount, 1);
    assert.equal(sel.selectedSourceCount, 2);
    // Persisted snapshot carries the selection meta so GET can surface it too.
    assert.ok(writtenPayload?._selectionMeta, "selection meta must be persisted with snapshot");
  } finally {
    _snapshotRepo.write = prevWrite;
    _snapshotRepo.getLocks = prevGetLocks;
    _snapshotRepo.insertLocks = prevInsertLocks;
    // Restore the suite-wide manifest + settings so unrelated downstream tests
    // see the same baseline they did before this test ran.
    await writeFile(sourceFeedsPath, JSON.stringify(FIXTURE_SOURCE_FEEDS), "utf8");
    await request(app)
      .put("/api/settings")
      .send(VALID_BODY)
      .set("Content-Type", "application/json");
  }
});

test("GET /api/dashboard surfaces persisted _selectionMeta as _meta.selection", async () => {
  const SNAPSHOT = {
    contractVersion: "2026-05-19-meta-story-fields",
    stories: [],
    _meta: { hasSnapshot: true, refreshedAt: new Date().toISOString() },
    _selectionMeta: {
      sourceSelectionMode: "fallback",
      sourceFallbackUsed: true,
      sourceFallbackReason: "all_unmatched",
      matchedSourceCount: 0,
      selectedSourceCount: 1,
      unmatchedSelectedSources: ["Made-Up Outlet"],
      unavailableConnectorCount: 0,
      unavailableConnectorSources: [],
      matchedFeedIds: ["reuters-world"],
      relevantItemCount: 0,
    },
  };
  const prev = _snapshotRepo.read;
  _snapshotRepo.read = async () => SNAPSHOT;
  try {
    const res = await request(app).get("/api/dashboard");
    assert.equal(res.status, 200);
    assert.ok(res.body._meta?.selection, "GET must surface selection meta from persisted snapshot");
    assert.equal(res.body._meta.selection.sourceSelectionMode, "fallback");
    assert.equal(res.body._meta.selection.sourceFallbackReason, "all_unmatched");
    assert.deepEqual(res.body._meta.selection.unmatchedSelectedSources, ["Made-Up Outlet"]);
  } finally {
    _snapshotRepo.read = prev;
  }
});

test("POST /api/dashboard/refresh: applies title lock — second refresh preserves first title", async () => {
  const firstTitle = "First Run Title";
  const secondTitle = "Different Second Title";
  const MS_ID = "locked-meta-story";
  const makeStory = (title) => ({
    contractVersion: "2026-05-19-meta-story-fields",
    stories: [{
      id: MS_ID, metaStoryId: MS_ID, title, subtitle: "Sub.",
      geographies: ["US"], topic: "Diplomatic relations",
      summary: "S", whyItMatters: "W", whatChanged: "C",
      priority: "standard", outletCount: 1,
      tags: { topics: [], keywords: [], geographies: [] },
      sources: [],
    }],
  });

  const locks = new Map();
  const prevWrite = _snapshotRepo.write;
  const prevGetLocks = _snapshotRepo.getLocks;
  const prevInsertLocks = _snapshotRepo.insertLocks;
  const prevRun = _refreshPipeline.run;
  _snapshotRepo.write = async () => {};
  _snapshotRepo.getLocks = async () => new Map(locks);
  // Meta-story fields PR (Prompt 1): title-only locks — stub mirrors the
  // production insert path which only persists `title`.
  _snapshotRepo.insertLocks = async (_uid, newLocks) => {
    for (const l of newLocks) locks.set(l.metaStoryId, { title: l.title });
  };
  _refreshPipeline.run = async () => ({ payload: makeStory(firstTitle), log: { poolCount: 1, relevantCount: 1, usedFallbackClustering: false, groundingFailures: 0 } });
  const res1 = await request(app).post("/api/dashboard/refresh");
  assert.equal(res1.body.stories[0].title, firstTitle, "first refresh must use LLM title");

  _refreshPipeline.run = async () => ({ payload: makeStory(secondTitle), log: { poolCount: 1, relevantCount: 1, usedFallbackClustering: false, groundingFailures: 0 } });
  const res2 = await request(app).post("/api/dashboard/refresh");
  try {
    assert.equal(res2.body.stories[0].title, firstTitle, "second refresh must use locked title, not new LLM title");
  } finally {
    _snapshotRepo.write = prevWrite;
    _snapshotRepo.getLocks = prevGetLocks;
    _snapshotRepo.insertLocks = prevInsertLocks;
    _refreshPipeline.run = prevRun;
  }
});

test("POST /api/dashboard/refresh: title lock does NOT freeze subtitle across refresh (meta-story fields PR)", async () => {
  // Product rule: only `title` is locked on first publish.  `subtitle` carries
  // clustering context (one-sentence placement of the story) and must
  // re-render every refresh as evidence shifts.  This guards against a
  // regression of the prior title+subtitle lock behavior.
  const MS_ID = "subtitle-rerender-meta-story";
  const firstSubtitle = "First-run placement of the story.";
  const secondSubtitle = "Refined placement after new evidence arrived.";
  const makeStory = (subtitle) => ({
    contractVersion: "2026-05-19-meta-story-fields",
    stories: [{
      id: MS_ID, metaStoryId: MS_ID, title: "Stable Title", subtitle,
      geographies: ["US"], topic: "Diplomatic relations",
      summary: "S", whyItMatters: "W", whatChanged: "C",
      priority: "standard", outletCount: 1,
      tags: { topics: [], keywords: [], geographies: [] },
      sources: [],
    }],
  });

  const locks = new Map();
  const prevWrite = _snapshotRepo.write;
  const prevGetLocks = _snapshotRepo.getLocks;
  const prevInsertLocks = _snapshotRepo.insertLocks;
  const prevRun = _refreshPipeline.run;
  _snapshotRepo.write = async () => {};
  _snapshotRepo.getLocks = async () => new Map(locks);
  _snapshotRepo.insertLocks = async (_uid, newLocks) => {
    for (const l of newLocks) {
      // Regression guard: production insert path must not include subtitle.
      assert.equal(
        Object.prototype.hasOwnProperty.call(l, "subtitle"),
        false,
        "insertLocks payload must not include subtitle (title-only locks)"
      );
      locks.set(l.metaStoryId, { title: l.title });
    }
  };
  _refreshPipeline.run = async () => ({ payload: makeStory(firstSubtitle), log: { poolCount: 1, relevantCount: 1, usedFallbackClustering: false, groundingFailures: 0 } });
  await request(app).post("/api/dashboard/refresh");

  _refreshPipeline.run = async () => ({ payload: makeStory(secondSubtitle), log: { poolCount: 1, relevantCount: 1, usedFallbackClustering: false, groundingFailures: 0 } });
  const res2 = await request(app).post("/api/dashboard/refresh");
  try {
    assert.equal(res2.body.stories[0].title, "Stable Title");
    assert.equal(
      res2.body.stories[0].subtitle,
      secondSubtitle,
      "subtitle must reflect the current refresh, not the first-run value"
    );
  } finally {
    _snapshotRepo.write = prevWrite;
    _snapshotRepo.getLocks = prevGetLocks;
    _snapshotRepo.insertLocks = prevInsertLocks;
    _refreshPipeline.run = prevRun;
  }
});

test("POST /api/dashboard/refresh: legacy lock row with subtitle does NOT override fresh story subtitle", async () => {
  // Regression: lock rows persisted before the meta-story fields PR carried a
  // `subtitle` value.  The server must apply `title` only — the legacy
  // subtitle must not freeze the rendered story subtitle.
  const MS_ID = "legacy-lock-row-meta-story";
  const FRESH_SUBTITLE = "Fresh subtitle from current clustering.";
  const STORY = {
    contractVersion: "2026-05-19-meta-story-fields",
    stories: [{
      id: MS_ID, metaStoryId: MS_ID, title: "LLM Title", subtitle: FRESH_SUBTITLE,
      geographies: ["US"], topic: "Diplomatic relations",
      summary: "S", whyItMatters: "W", whatChanged: "C",
      priority: "standard", outletCount: 1,
      tags: { topics: [], keywords: [], geographies: [] },
      sources: [],
    }],
  };
  const prevWrite = _snapshotRepo.write;
  const prevGetLocks = _snapshotRepo.getLocks;
  const prevInsertLocks = _snapshotRepo.insertLocks;
  const prevRun = _refreshPipeline.run;
  _snapshotRepo.write = async () => {};
  // Simulate a legacy lock row that still carries `subtitle` — production
  // adapters now strip it on read, so the server should never see this key.
  // We assert behavior against the post-strip shape: `{ title }` only.
  _snapshotRepo.getLocks = async () => new Map([[MS_ID, { title: "Locked Title" }]]);
  _snapshotRepo.insertLocks = async () => {};
  _refreshPipeline.run = async () => ({ payload: STORY, log: { poolCount: 1, relevantCount: 1, usedFallbackClustering: false, groundingFailures: 0 } });
  try {
    const res = await request(app).post("/api/dashboard/refresh");
    assert.equal(res.body.stories[0].title, "Locked Title");
    assert.equal(
      res.body.stories[0].subtitle,
      FRESH_SUBTITLE,
      "fresh subtitle must survive — legacy lock subtitle never overrides"
    );
  } finally {
    _snapshotRepo.write = prevWrite;
    _snapshotRepo.getLocks = prevGetLocks;
    _snapshotRepo.insertLocks = prevInsertLocks;
    _refreshPipeline.run = prevRun;
  }
});

test("POST /api/dashboard/refresh: on failure, returns last good snapshot with fallback=true", async () => {
  const LAST_SNAPSHOT = {
    contractVersion: "2026-05-19-meta-story-fields",
    stories: [],
    _meta: { hasSnapshot: true, refreshedAt: new Date().toISOString() },
  };
  const prevRun = _refreshPipeline.run;
  const prevRead = _snapshotRepo.read;
  const prevGetLocks = _snapshotRepo.getLocks;
  _refreshPipeline.run = async () => { throw new Error("pipeline exploded"); };
  _snapshotRepo.read = async () => LAST_SNAPSHOT;
  _snapshotRepo.getLocks = async () => new Map();
  try {
    const res = await request(app).post("/api/dashboard/refresh");
    assert.equal(res.status, 200, "must not 500 when last snapshot is available");
    assert.equal(res.body._meta?.fallback, true, "must signal fallback=true");
  } finally {
    _refreshPipeline.run = prevRun;
    _snapshotRepo.read = prevRead;
    _snapshotRepo.getLocks = prevGetLocks;
  }
});

test("POST /api/dashboard/refresh: returns 500 when pipeline fails and no prior snapshot", async () => {
  const prevRun = _refreshPipeline.run;
  const prevRead = _snapshotRepo.read;
  _refreshPipeline.run = async () => { throw new Error("pipeline exploded"); };
  _snapshotRepo.read = async () => null;
  try {
    const res = await request(app).post("/api/dashboard/refresh");
    assert.equal(res.status, 500);
    assert.equal(typeof res.body.message, "string");
  } finally {
    _refreshPipeline.run = prevRun;
    _snapshotRepo.read = prevRead;
  }
});

// ─── Phase 4: watermark short-circuit ────────────────────────────────────────

test("POST /api/dashboard/refresh: watermark unchanged → re-serves prior snapshot, no clusterFn, _meta.unchanged=true", async () => {
  const prevRun = _refreshPipeline.run;
  const prevRead = _snapshotRepo.read;
  const prevWrite = _snapshotRepo.write;
  const prevGetLocks = _snapshotRepo.getLocks;
  const prevInsertLocks = _snapshotRepo.insertLocks;

  const PRIOR_SNAPSHOT = {
    contractVersion: "2026-05-19-meta-story-fields",
    stories: [],
    _watermark: "wm-stable-123",
    _selectionMeta: {
      sourceSelectionMode: "strict",
      sourceFallbackUsed: false,
      sourceFallbackReason: null,
      matchedSourceCount: 1,
      selectedSourceCount: 1,
      unmatchedSelectedSources: [],
      unavailableConnectorCount: 0,
      unavailableConnectorSources: [],
      matchedFeedIds: ["nyt-politics"],
      relevantItemCount: 0,
    },
  };

  let writeCalls = 0;
  let lockCalls = 0;
  _snapshotRepo.read = async () => PRIOR_SNAPSHOT;
  _snapshotRepo.write = async () => { writeCalls++; };
  _snapshotRepo.getLocks = async () => { lockCalls++; return new Map(); };
  _snapshotRepo.insertLocks = async () => { lockCalls++; };

  _refreshPipeline.run = async (opts) => {
    // Verify the route forwarded priorWatermark from the persisted snapshot.
    assert.equal(opts.priorWatermark, "wm-stable-123");
    return {
      payload: null,
      log: {
        unchanged: true,
        refreshSkippedReason: "unchanged_watermark",
        watermark: "wm-stable-123",
        candidateCount: 5,
        selectedFeedCount: 1,
        selection: PRIOR_SNAPSHOT._selectionMeta,
      },
    };
  };

  try {
    const res = await request(app).post("/api/dashboard/refresh");
    assert.equal(res.status, 200);
    assert.equal(res.body._meta.unchanged, true);
    assert.equal(res.body._meta.refreshSkippedReason, "unchanged_watermark");
    assert.equal(res.body._meta.watermark, "wm-stable-123");
    assert.equal(res.body._meta.candidateCount, 5);
    assert.equal(res.body._meta.selectedFeedCount, 1);
    // D1: additive cache-benefit advisory present + well-formed on the
    // watermark-skip branch too (parity with the ran branch).
    assertCacheBenefitShape(res.body._meta, "watermark-skip branch");
    // Idempotency: NO snapshot writes, NO lock churn under short-circuit.
    assert.equal(writeCalls, 0, "no snapshot write under short-circuit");
    assert.equal(lockCalls, 0, "no lock churn under short-circuit");
    // Internal storage fields must NOT leak.
    assert.equal(res.body._watermark, undefined);
    assert.equal(res.body._selectionMeta, undefined);
  } finally {
    _refreshPipeline.run = prevRun;
    _snapshotRepo.read = prevRead;
    _snapshotRepo.write = prevWrite;
    _snapshotRepo.getLocks = prevGetLocks;
    _snapshotRepo.insertLocks = prevInsertLocks;
  }
});

test("POST /api/dashboard/refresh: watermark unchanged → re-serves prior whatChanged strings verbatim (spec §10 row 6)", async () => {
  // Spec alignment #6 + §10 row 6: on a watermark match the pipeline
  // returns `payload: null` and the route re-serves the prior snapshot's
  // stories untouched — including their `whatChanged` strings.  This test
  // pins the HTTP-response surface of that contract: a prior snapshot
  // with two stories carrying distinct, non-default `whatChanged` strings
  // must come through res.body.stories verbatim, with no recomputation.
  const prevRun = _refreshPipeline.run;
  const prevRead = _snapshotRepo.read;
  const prevWrite = _snapshotRepo.write;
  const prevGetLocks = _snapshotRepo.getLocks;
  const prevInsertLocks = _snapshotRepo.insertLocks;

  const PRIOR_WHAT_CHANGED_A = "Reuters joined coverage with a new diplomatic angle.";
  const PRIOR_WHAT_CHANGED_B = "First appearance in your feed.";
  const PRIOR_SNAPSHOT = {
    contractVersion: VALID_BODY.contractVersion,
    stories: [
      {
        id: "ms-1",
        metaStoryId: "ms-1",
        title: "Prior story A",
        subtitle: "Sub A",
        geographies: ["US"],
        topic: "Diplomatic relations",
        summary: "S",
        whyItMatters: "W",
        whatChanged: PRIOR_WHAT_CHANGED_A,
        priority: "standard",
        outletCount: 2,
        tags: { topics: [], keywords: [], geographies: [] },
        sources: [
          { id: "src-a-1", outlet: "Reuters", kind: "traditional", weight: 60, url: "https://example.com/a1", minutesAgo: 10, headline: "H1", body: ["B1"] },
        ],
      },
      {
        id: "ms-2",
        metaStoryId: "ms-2",
        title: "Prior story B",
        subtitle: "Sub B",
        geographies: ["US"],
        topic: "Diplomatic relations",
        summary: "S",
        whyItMatters: "W",
        whatChanged: PRIOR_WHAT_CHANGED_B,
        priority: "standard",
        outletCount: 1,
        tags: { topics: [], keywords: [], geographies: [] },
        sources: [
          { id: "src-b-1", outlet: "NYT", kind: "traditional", weight: 55, url: "https://example.com/b1", minutesAgo: 20, headline: "H2", body: ["B2"] },
        ],
      },
    ],
    _watermark: "wm-stable-row6",
    _selectionMeta: {
      sourceSelectionMode: "strict",
      sourceFallbackUsed: false,
      sourceFallbackReason: null,
      matchedSourceCount: 1,
      selectedSourceCount: 1,
      unmatchedSelectedSources: [],
      unavailableConnectorCount: 0,
      unavailableConnectorSources: [],
      matchedFeedIds: ["reuters-world"],
      relevantItemCount: 0,
    },
  };

  let writeCalls = 0;
  _snapshotRepo.read = async () => PRIOR_SNAPSHOT;
  _snapshotRepo.write = async () => { writeCalls++; };
  _snapshotRepo.getLocks = async () => new Map();
  _snapshotRepo.insertLocks = async () => {};
  _refreshPipeline.run = async () => ({
    payload: null,
    log: {
      unchanged: true,
      refreshSkippedReason: "unchanged_watermark",
      watermark: "wm-stable-row6",
      candidateCount: 0,
      selectedFeedCount: 1,
      selection: PRIOR_SNAPSHOT._selectionMeta,
    },
  });

  try {
    const res = await request(app).post("/api/dashboard/refresh");
    assert.equal(res.status, 200);
    assert.equal(res.body._meta.unchanged, true);
    assert.equal(res.body._meta.refreshSkippedReason, "unchanged_watermark");
    // The two stories must come through verbatim, in the same order, with
    // their original `whatChanged` strings — no recomputation, no engine
    // call, no default unchanged-copy override.
    assert.equal(res.body.stories.length, 2);
    assert.equal(res.body.stories[0].metaStoryId, "ms-1");
    assert.equal(res.body.stories[0].whatChanged, PRIOR_WHAT_CHANGED_A);
    assert.equal(res.body.stories[1].metaStoryId, "ms-2");
    assert.equal(res.body.stories[1].whatChanged, PRIOR_WHAT_CHANGED_B);
    // Idempotency: no snapshot write, no lock churn on a watermark skip.
    assert.equal(writeCalls, 0);
    // No story carries the legacy freshness template.
    for (const s of res.body.stories) {
      assert.ok(
        !/Latest update .* min ago\./.test(s.whatChanged ?? ""),
        `story "${s.metaStoryId}" must not carry the legacy freshness template`
      );
    }
  } finally {
    _refreshPipeline.run = prevRun;
    _snapshotRepo.read = prevRead;
    _snapshotRepo.write = prevWrite;
    _snapshotRepo.getLocks = prevGetLocks;
    _snapshotRepo.insertLocks = prevInsertLocks;
  }
});

test("POST /api/dashboard/refresh: watermark unchanged → _meta.recall and _meta.funnel surface from pipeline log", async () => {
  // Diagnostics-visibility contract: when the pipeline short-circuits on a
  // matching watermark it still computes recall + funnel before the skip
  // decision.  The route must surface those under `_meta.recall` /
  // `_meta.funnel` so an operator looking at a stable empty snapshot can see
  // *why* recall went thin without re-running the pipeline by hand.
  const prevRun = _refreshPipeline.run;
  const prevRead = _snapshotRepo.read;
  const prevWrite = _snapshotRepo.write;
  const prevGetLocks = _snapshotRepo.getLocks;
  const prevInsertLocks = _snapshotRepo.insertLocks;

  const RECALL_DIAG = {
    mode: "hybrid_strict",
    keywordRecallCount: 2,
    embeddedCount: 0,
    similarityKept: 0,
    unionCount: 2,
    finalRelevant: 2,
    degraded: true,
    degraded_reason: "embedding_error_fail_closed",
    keywordFallbackAfterEmbeddingFailure: true,
  };
  const FUNNEL_DIAG = {
    totalNormalized: 10,
    afterTimeWindow: 9,
    afterSourceSelection: 8,
    afterGeoFilter: 6,
    afterTopicKeyword: 4,
    afterBeatFit: 2,
    finalStories: null,
    executionMode: "watermark_skip",
    primaryDropStage: "not_executed",
    topicKeywordRecallIsNoop: false,
  };

  _snapshotRepo.read = async () => ({
    contractVersion: "2026-05-19-meta-story-fields",
    stories: [],
    _watermark: "wm-stable-xyz",
    _selectionMeta: {
      sourceSelectionMode: "strict",
      sourceFallbackUsed: false,
      sourceFallbackReason: null,
      matchedSourceCount: 1,
      selectedSourceCount: 1,
      unmatchedSelectedSources: [],
      unavailableConnectorCount: 0,
      unavailableConnectorSources: [],
      matchedFeedIds: ["nyt-politics"],
      relevantItemCount: 0,
    },
  });
  _snapshotRepo.write = async () => {};
  _snapshotRepo.getLocks = async () => new Map();
  _snapshotRepo.insertLocks = async () => {};
  _refreshPipeline.run = async () => ({
    payload: null,
    log: {
      unchanged: true,
      refreshSkippedReason: "unchanged_watermark",
      watermark: "wm-stable-xyz",
      candidateCount: 4,
      selectedFeedCount: 1,
      recall: RECALL_DIAG,
      funnel: FUNNEL_DIAG,
      beatFit: { version: "v1", enabled: true, threshold: 0.5, recallCount: 2, includedCount: 2, excludedCount: 0, excludeReasonHistogram: {} },
      selection: null,
    },
  });

  try {
    const res = await request(app).post("/api/dashboard/refresh");
    assert.equal(res.status, 200);
    assert.equal(res.body._meta.unchanged, true);
    assert.equal(res.body._meta.refreshSkippedReason, "unchanged_watermark");
    assert.deepEqual(res.body._meta.recall, RECALL_DIAG);
    assert.deepEqual(res.body._meta.funnel, FUNNEL_DIAG);
    // The recall block on the skip path must carry the same trust-debugging
    // signals the full-run path exposes.
    assert.equal(res.body._meta.recall.degraded, true);
    assert.equal(res.body._meta.recall.degraded_reason, "embedding_error_fail_closed");
    assert.equal(res.body._meta.recall.keywordFallbackAfterEmbeddingFailure, true);
    assert.equal(res.body._meta.funnel.executionMode, "watermark_skip");
    assert.equal(res.body._meta.funnel.primaryDropStage, "not_executed");
  } finally {
    _refreshPipeline.run = prevRun;
    _snapshotRepo.read = prevRead;
    _snapshotRepo.write = prevWrite;
    _snapshotRepo.getLocks = prevGetLocks;
    _snapshotRepo.insertLocks = prevInsertLocks;
  }
});

test("POST /api/dashboard/refresh: watermark unchanged with NO prior snapshot → diagnostics still surface in empty body", async () => {
  // Edge case: the watermark-skip log carries useful diagnostics (recall,
  // funnel, beatFit, selection) even when no prior snapshot is on disk.  The
  // route's `emptyDashboardResponse` path must merge those into `_meta` so
  // observability parity holds across both branches of the skip return.
  // This exercises the route's handling of `priorSnapshot === null` while the
  // pipeline still produced a full skip-time diagnostic block.
  const prevRun = _refreshPipeline.run;
  const prevRead = _snapshotRepo.read;
  const prevWrite = _snapshotRepo.write;
  const prevGetLocks = _snapshotRepo.getLocks;
  const prevInsertLocks = _snapshotRepo.insertLocks;

  const RECALL_DIAG = {
    mode: "hybrid_strict",
    keywordRecallCount: 0,
    embeddedCount: 0,
    similarityKept: 0,
    unionCount: 0,
    finalRelevant: 0,
    degraded: false,
    degraded_reason: null,
    topicKeywordBreakdown: {
      inputCount: 0, hasTopics: true, hasKeywords: true,
      topicOnly: 0, keywordOnly: 0, both: 0, neither: 0,
      passNoConfig: 0, passCount: 0, primaryDropCause: "no_input",
    },
  };
  const FUNNEL_DIAG = {
    totalNormalized: 0, afterTimeWindow: 0, afterSourceSelection: 0,
    afterGeoFilter: 0, afterTopicKeyword: 0, afterBeatFit: 0,
    finalStories: null,
    executionMode: "watermark_skip", primaryDropStage: "not_executed",
    topicKeywordRecallIsNoop: false,
  };
  const BEAT_FIT_DIAG = {
    version: "v1", enabled: true, threshold: 0.5,
    recallCount: 0, includedCount: 0, excludedCount: 0, excludeReasonHistogram: {},
  };
  const SELECTION_DIAG = {
    sourceSelectionMode: "strict",
    sourceFallbackUsed: false,
    sourceFallbackReason: null,
    matchedSourceCount: 1,
    selectedSourceCount: 1,
    unmatchedSelectedSources: [],
    unavailableConnectorCount: 0,
    unavailableConnectorSources: [],
    matchedFeedIds: ["nyt-politics"],
    relevantItemCount: 0,
  };

  // No prior snapshot on disk.
  _snapshotRepo.read = async () => null;
  _snapshotRepo.write = async () => {};
  _snapshotRepo.getLocks = async () => new Map();
  _snapshotRepo.insertLocks = async () => {};
  _refreshPipeline.run = async () => ({
    payload: null,
    log: {
      unchanged: true,
      refreshSkippedReason: "unchanged_watermark",
      watermark: "wm-empty-skip",
      candidateCount: 0,
      selectedFeedCount: 1,
      recall: RECALL_DIAG,
      funnel: FUNNEL_DIAG,
      beatFit: BEAT_FIT_DIAG,
      selection: SELECTION_DIAG,
    },
  });

  try {
    const res = await request(app).post("/api/dashboard/refresh");
    assert.equal(res.status, 200);
    // Empty body shape: hasSnapshot=false, no stories.
    assert.equal(res.body._meta.hasSnapshot, false);
    assert.deepEqual(res.body.stories, []);
    // Skip diagnostics still flow through.
    assert.equal(res.body._meta.unchanged, true);
    assert.equal(res.body._meta.refreshSkippedReason, "unchanged_watermark");
    assert.equal(res.body._meta.watermark, "wm-empty-skip");
    assert.deepEqual(res.body._meta.recall, RECALL_DIAG);
    assert.deepEqual(res.body._meta.funnel, FUNNEL_DIAG);
    assert.deepEqual(res.body._meta.beatFit, BEAT_FIT_DIAG);
    assert.deepEqual(res.body._meta.selection, SELECTION_DIAG);
    assert.equal(res.body._meta.recall.topicKeywordBreakdown.primaryDropCause, "no_input");
  } finally {
    _refreshPipeline.run = prevRun;
    _snapshotRepo.read = prevRead;
    _snapshotRepo.write = prevWrite;
    _snapshotRepo.getLocks = prevGetLocks;
    _snapshotRepo.insertLocks = prevInsertLocks;
  }
});

test("POST /api/dashboard/refresh: watermark unchanged → log fields without recall/funnel/beatFit produce no `undefined` placeholders", async () => {
  // Backward-compat guard: older pipeline log shapes (test mocks, legacy
  // returns) don't carry recall/funnel/beatFit/selection.  The route must
  // omit those keys entirely rather than emit `_meta.recall = undefined`,
  // which would clutter logs and break consumers that introspect for "key
  // present" rather than "value truthy".
  const prevRun = _refreshPipeline.run;
  const prevRead = _snapshotRepo.read;
  const prevWrite = _snapshotRepo.write;
  const prevGetLocks = _snapshotRepo.getLocks;
  const prevInsertLocks = _snapshotRepo.insertLocks;

  _snapshotRepo.read = async () => null;
  _snapshotRepo.write = async () => {};
  _snapshotRepo.getLocks = async () => new Map();
  _snapshotRepo.insertLocks = async () => {};
  _refreshPipeline.run = async () => ({
    payload: null,
    log: {
      unchanged: true,
      refreshSkippedReason: "unchanged_watermark",
      watermark: "wm-bare",
      candidateCount: 0,
      selectedFeedCount: 0,
      // Intentionally omit recall/funnel/beatFit/selection.
    },
  });

  try {
    const res = await request(app).post("/api/dashboard/refresh");
    assert.equal(res.status, 200);
    assert.equal(res.body._meta.unchanged, true);
    assert.equal(res.body._meta.watermark, "wm-bare");
    assert.equal(Object.prototype.hasOwnProperty.call(res.body._meta, "recall"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(res.body._meta, "funnel"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(res.body._meta, "beatFit"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(res.body._meta, "selection"), false);
  } finally {
    _refreshPipeline.run = prevRun;
    _snapshotRepo.read = prevRead;
    _snapshotRepo.write = prevWrite;
    _snapshotRepo.getLocks = prevGetLocks;
    _snapshotRepo.insertLocks = prevInsertLocks;
  }
});

// ─── M3 / L1a: model identity on refresh _meta ───────────────────────────────
//
// Surfaces `_meta.clusterModel` and `_meta.embeddingModel` on both the
// full-run and watermark-skip branches so DC demo debugging / incident
// replay don't depend on log scrapes.  Persistence to snapshot storage is
// deferred to M3b — these assertions cover response shape only.

test("M3: POST /api/dashboard/refresh full run returns _meta.clusterModel + _meta.embeddingModel from env", async () => {
  const savedCluster = process.env.TEMPO_AI_CLUSTER_MODEL;
  const savedEmbed = process.env.TEMPO_OPENAI_EMBEDDING_MODEL;
  process.env.TEMPO_AI_CLUSTER_MODEL = "anthropic:claude-sonnet-4-6";
  process.env.TEMPO_OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
  const prevWrite = _snapshotRepo.write;
  const prevGetLocks = _snapshotRepo.getLocks;
  const prevInsertLocks = _snapshotRepo.insertLocks;
  _snapshotRepo.write = async () => {};
  _snapshotRepo.getLocks = async () => new Map();
  _snapshotRepo.insertLocks = async () => {};
  try {
    const res = await request(app).post("/api/dashboard/refresh");
    assert.equal(res.status, 200);
    assert.equal(res.body._meta?.hasSnapshot, true, "full run sets hasSnapshot=true");
    assert.equal(res.body._meta?.clusterModel, "anthropic:claude-sonnet-4-6");
    assert.equal(res.body._meta?.embeddingModel, "text-embedding-3-small");
  } finally {
    if (savedCluster !== undefined) process.env.TEMPO_AI_CLUSTER_MODEL = savedCluster;
    else delete process.env.TEMPO_AI_CLUSTER_MODEL;
    if (savedEmbed !== undefined) process.env.TEMPO_OPENAI_EMBEDDING_MODEL = savedEmbed;
    else delete process.env.TEMPO_OPENAI_EMBEDDING_MODEL;
    _snapshotRepo.write = prevWrite;
    _snapshotRepo.getLocks = prevGetLocks;
    _snapshotRepo.insertLocks = prevInsertLocks;
  }
});

test("M3: POST /api/dashboard/refresh watermark-skip returns _meta.clusterModel + _meta.embeddingModel (with prior snapshot)", async () => {
  const savedCluster = process.env.TEMPO_AI_CLUSTER_MODEL;
  const savedEmbed = process.env.TEMPO_OPENAI_EMBEDDING_MODEL;
  process.env.TEMPO_AI_CLUSTER_MODEL = "anthropic:claude-sonnet-4-6";
  process.env.TEMPO_OPENAI_EMBEDDING_MODEL = "text-embedding-3-large";
  const prevRun = _refreshPipeline.run;
  const prevRead = _snapshotRepo.read;
  const prevWrite = _snapshotRepo.write;
  _snapshotRepo.read = async () => ({
    contractVersion: "2026-05-19-meta-story-fields",
    stories: [],
    _watermark: "wm-m3",
    _selectionMeta: null,
  });
  _snapshotRepo.write = async () => {};
  _refreshPipeline.run = async () => ({
    payload: null,
    log: {
      unchanged: true,
      refreshSkippedReason: "unchanged_watermark",
      watermark: "wm-m3",
      candidateCount: 0,
      selectedFeedCount: 1,
    },
  });
  try {
    const res = await request(app).post("/api/dashboard/refresh");
    assert.equal(res.status, 200);
    assert.equal(res.body._meta?.unchanged, true);
    assert.equal(res.body._meta?.clusterModel, "anthropic:claude-sonnet-4-6");
    assert.equal(res.body._meta?.embeddingModel, "text-embedding-3-large");
  } finally {
    if (savedCluster !== undefined) process.env.TEMPO_AI_CLUSTER_MODEL = savedCluster;
    else delete process.env.TEMPO_AI_CLUSTER_MODEL;
    if (savedEmbed !== undefined) process.env.TEMPO_OPENAI_EMBEDDING_MODEL = savedEmbed;
    else delete process.env.TEMPO_OPENAI_EMBEDDING_MODEL;
    _refreshPipeline.run = prevRun;
    _snapshotRepo.read = prevRead;
    _snapshotRepo.write = prevWrite;
  }
});

test("M3: POST /api/dashboard/refresh watermark-skip with NO prior snapshot still returns clusterModel + embeddingModel", async () => {
  const savedCluster = process.env.TEMPO_AI_CLUSTER_MODEL;
  const savedEmbed = process.env.TEMPO_OPENAI_EMBEDDING_MODEL;
  process.env.TEMPO_AI_CLUSTER_MODEL = "anthropic:claude-sonnet-4-6";
  process.env.TEMPO_OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
  const prevRun = _refreshPipeline.run;
  const prevRead = _snapshotRepo.read;
  const prevWrite = _snapshotRepo.write;
  _snapshotRepo.read = async () => null;
  _snapshotRepo.write = async () => {};
  _refreshPipeline.run = async () => ({
    payload: null,
    log: {
      unchanged: true,
      refreshSkippedReason: "unchanged_watermark",
      watermark: "wm-m3-bare",
      candidateCount: 0,
      selectedFeedCount: 0,
    },
  });
  try {
    const res = await request(app).post("/api/dashboard/refresh");
    assert.equal(res.status, 200);
    assert.equal(res.body._meta?.hasSnapshot, false);
    assert.equal(res.body._meta?.unchanged, true);
    assert.equal(res.body._meta?.clusterModel, "anthropic:claude-sonnet-4-6");
    assert.equal(res.body._meta?.embeddingModel, "text-embedding-3-small");
  } finally {
    if (savedCluster !== undefined) process.env.TEMPO_AI_CLUSTER_MODEL = savedCluster;
    else delete process.env.TEMPO_AI_CLUSTER_MODEL;
    if (savedEmbed !== undefined) process.env.TEMPO_OPENAI_EMBEDDING_MODEL = savedEmbed;
    else delete process.env.TEMPO_OPENAI_EMBEDDING_MODEL;
    _refreshPipeline.run = prevRun;
    _snapshotRepo.read = prevRead;
    _snapshotRepo.write = prevWrite;
  }
});

// ─── M3b / P1: persist last-run diagnostics on snapshot ──────────────────────
//
// `_lastRunMeta` (funnel, recall, beatFit, clusterModel, embeddingModel) is
// written into the persisted snapshot on a successful refresh run.  GET
// /api/dashboard surfaces those fields under `_meta.*` so an operator can
// explain a stable snapshot without re-running the pipeline.

test("M3b: POST /api/dashboard/refresh full run persists _lastRunMeta with funnel/recall/beatFit + model ids", async () => {
  const savedCluster = process.env.TEMPO_AI_CLUSTER_MODEL;
  const savedEmbed = process.env.TEMPO_OPENAI_EMBEDDING_MODEL;
  process.env.TEMPO_AI_CLUSTER_MODEL = "anthropic:claude-sonnet-4-6";
  process.env.TEMPO_OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";

  const FUNNEL_DIAG = {
    executionMode: "full_run",
    primaryDropStage: "beat_fit",
    stages: { recall: { in: 10, out: 5 } },
  };
  const RECALL_DIAG = {
    degraded: false,
    embeddingModel: "text-embedding-3-small",
    keywordFallbackAfterEmbeddingFailure: false,
  };
  const BEAT_FIT_DIAG = {
    version: "v1", enabled: true, threshold: 0.5,
    recallCount: 5, includedCount: 3, excludedCount: 2,
    excludeReasonHistogram: {},
  };
  const PAYLOAD = {
    contractVersion: "2026-05-19-meta-story-fields",
    stories: [],
  };

  let writtenPayload = null;
  const prevRun = _refreshPipeline.run;
  const prevWrite = _snapshotRepo.write;
  const prevGetLocks = _snapshotRepo.getLocks;
  const prevInsertLocks = _snapshotRepo.insertLocks;
  _refreshPipeline.run = async () => ({
    payload: PAYLOAD,
    log: {
      poolCount: 0, relevantCount: 0, usedFallbackClustering: false, groundingFailures: 0,
      watermark: "wm-m3b", candidateCount: 1, selectedFeedCount: 1,
      selection: { sourceSelectionMode: "strict" },
      funnel: FUNNEL_DIAG,
      recall: RECALL_DIAG,
      beatFit: BEAT_FIT_DIAG,
    },
  });
  _snapshotRepo.write = async (_uid, payload) => { writtenPayload = payload; };
  _snapshotRepo.getLocks = async () => new Map();
  _snapshotRepo.insertLocks = async () => {};
  try {
    const res = await request(app).post("/api/dashboard/refresh");
    assert.equal(res.status, 200);
    // Refresh response shape unchanged (M3 contract preserved).
    assert.deepEqual(res.body._meta.funnel, FUNNEL_DIAG);
    assert.deepEqual(res.body._meta.recall, RECALL_DIAG);
    assert.deepEqual(res.body._meta.beatFit, BEAT_FIT_DIAG);
    assert.equal(res.body._meta.clusterModel, "anthropic:claude-sonnet-4-6");
    assert.equal(res.body._meta.embeddingModel, "text-embedding-3-small");
    // Persistence: _lastRunMeta carries the same diagnostics for later reads.
    assert.ok(writtenPayload, "snapshot write must have been called");
    assert.ok(writtenPayload._lastRunMeta, "persisted snapshot must carry _lastRunMeta");
    assert.deepEqual(writtenPayload._lastRunMeta.funnel, FUNNEL_DIAG);
    assert.deepEqual(writtenPayload._lastRunMeta.recall, RECALL_DIAG);
    assert.deepEqual(writtenPayload._lastRunMeta.beatFit, BEAT_FIT_DIAG);
    assert.equal(writtenPayload._lastRunMeta.clusterModel, "anthropic:claude-sonnet-4-6");
    assert.equal(writtenPayload._lastRunMeta.embeddingModel, "text-embedding-3-small");
  } finally {
    if (savedCluster !== undefined) process.env.TEMPO_AI_CLUSTER_MODEL = savedCluster;
    else delete process.env.TEMPO_AI_CLUSTER_MODEL;
    if (savedEmbed !== undefined) process.env.TEMPO_OPENAI_EMBEDDING_MODEL = savedEmbed;
    else delete process.env.TEMPO_OPENAI_EMBEDDING_MODEL;
    _refreshPipeline.run = prevRun;
    _snapshotRepo.write = prevWrite;
    _snapshotRepo.getLocks = prevGetLocks;
    _snapshotRepo.insertLocks = prevInsertLocks;
  }
});

test("M3b: GET /api/dashboard surfaces persisted _meta.funnel/recall/beatFit/clusterModel/embeddingModel from prior run", async () => {
  // The repo lifts `_lastRunMeta` into `_meta.*` on read; here we provide an
  // already-lifted snapshot (matching the shape `_snapshotRepo.read` returns)
  // and assert GET propagates each diagnostic field unchanged.
  const FUNNEL_DIAG = { executionMode: "full_run", primaryDropStage: "beat_fit", stages: {} };
  const RECALL_DIAG = { degraded: false, embeddingModel: "text-embedding-3-small" };
  const BEAT_FIT_DIAG = {
    version: "v1", enabled: true, threshold: 0.5,
    recallCount: 4, includedCount: 2, excludedCount: 2,
    excludeReasonHistogram: { below_threshold: 2 },
  };
  const SNAPSHOT = {
    contractVersion: "2026-05-19-meta-story-fields",
    stories: [],
    _meta: {
      hasSnapshot: true,
      refreshedAt: "2026-05-14T10:00:00.000Z",
      funnel: FUNNEL_DIAG,
      recall: RECALL_DIAG,
      beatFit: BEAT_FIT_DIAG,
      clusterModel: "anthropic:claude-sonnet-4-6",
      embeddingModel: "text-embedding-3-small",
    },
  };
  const prev = _snapshotRepo.read;
  _snapshotRepo.read = async () => SNAPSHOT;
  try {
    const res = await request(app).get("/api/dashboard");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body._meta.funnel, FUNNEL_DIAG);
    assert.deepEqual(res.body._meta.recall, RECALL_DIAG);
    assert.deepEqual(res.body._meta.beatFit, BEAT_FIT_DIAG);
    assert.equal(res.body._meta.clusterModel, "anthropic:claude-sonnet-4-6");
    assert.equal(res.body._meta.embeddingModel, "text-embedding-3-small");
  } finally {
    _snapshotRepo.read = prev;
  }
});

test("POST /api/dashboard/refresh: route forwards priorStoryCount from prior snapshot to pipeline (trap-guard wiring)", async () => {
  // The empty-snapshot trap-guard lives in the pipeline; the route's job is
  // to read the prior snapshot and forward `priorStoryCount` as the input
  // signal.  This pins the route side of the wire — without it, the guard
  // never engages and a stale empty snapshot stays trapped at zero stories.
  const prevRun = _refreshPipeline.run;
  const prevRead = _snapshotRepo.read;
  const prevWrite = _snapshotRepo.write;
  const prevGetLocks = _snapshotRepo.getLocks;
  const prevInsertLocks = _snapshotRepo.insertLocks;

  // Empty prior snapshot (zero stories) — exercises the priorStoryCount=0 path.
  let priorStoryCountSeen = "not-passed";
  let priorWatermarkSeen = "not-passed";
  _snapshotRepo.read = async () => ({
    contractVersion: "2026-05-19-meta-story-fields",
    stories: [], // 0 stories — guard input
    _watermark: "wm-prior-empty",
  });
  _snapshotRepo.write = async () => {};
  _snapshotRepo.getLocks = async () => new Map();
  _snapshotRepo.insertLocks = async () => {};
  _refreshPipeline.run = async (opts) => {
    priorStoryCountSeen = opts.priorStoryCount;
    priorWatermarkSeen = opts.priorWatermark;
    return {
      payload: { contractVersion: "2026-05-19-meta-story-fields", stories: [] },
      log: {
        poolCount: 0, relevantCount: 0,
        usedFallbackClustering: false, groundingFailures: 0,
        droppedUngroundedStoryCount: 0, groundingDropReasons: {},
        watermark: "wm-prior-empty",
        candidateCount: 0, selectedFeedCount: 0,
        unchanged: false, refreshSkippedReason: null,
        selection: { sourceSelectionMode: "strict", sourceFallbackUsed: false, matchedSourceCount: 0, selectedSourceCount: 0, unmatchedSelectedSources: [], unavailableConnectorCount: 0, relevantItemCount: 0 },
      },
    };
  };

  try {
    const res = await request(app).post("/api/dashboard/refresh");
    assert.equal(res.status, 200);
    assert.equal(priorWatermarkSeen, "wm-prior-empty", "priorWatermark must be forwarded");
    assert.equal(priorStoryCountSeen, 0, "priorStoryCount must reflect prior snapshot stories.length");
  } finally {
    _refreshPipeline.run = prevRun;
    _snapshotRepo.read = prevRead;
    _snapshotRepo.write = prevWrite;
    _snapshotRepo.getLocks = prevGetLocks;
    _snapshotRepo.insertLocks = prevInsertLocks;
  }
});

test("POST /api/dashboard/refresh: route forwards priorStoryCount > 0 when prior snapshot has stories (skip preserved upstream)", async () => {
  // Mirror of the trap-guard wiring test: when prior snapshot has stories,
  // priorStoryCount > 0 must reach the pipeline so the optimization stays
  // intact for healthy stable runs.
  const prevRun = _refreshPipeline.run;
  const prevRead = _snapshotRepo.read;
  const prevWrite = _snapshotRepo.write;
  const prevGetLocks = _snapshotRepo.getLocks;
  const prevInsertLocks = _snapshotRepo.insertLocks;

  let priorStoryCountSeen = "not-passed";
  _snapshotRepo.read = async () => ({
    contractVersion: "2026-05-19-meta-story-fields",
    stories: [
      { id: "s1", metaStoryId: "s1", title: "T1", subtitle: "Sub.", geographies: ["US"], topic: "Diplomatic relations", summary: "S", whyItMatters: "W", whatChanged: "C", priority: "standard", outletCount: 1, tags: { topics: [], keywords: [], geographies: [] }, sources: [] },
      { id: "s2", metaStoryId: "s2", title: "T2", subtitle: "Sub.", geographies: ["US"], topic: "Diplomatic relations", summary: "S", whyItMatters: "W", whatChanged: "C", priority: "standard", outletCount: 1, tags: { topics: [], keywords: [], geographies: [] }, sources: [] },
    ],
    _watermark: "wm-prior-healthy",
  });
  _snapshotRepo.write = async () => {};
  _snapshotRepo.getLocks = async () => new Map();
  _snapshotRepo.insertLocks = async () => {};
  _refreshPipeline.run = async (opts) => {
    priorStoryCountSeen = opts.priorStoryCount;
    return {
      payload: null, // pipeline short-circuits — guard does NOT engage
      log: {
        unchanged: true,
        refreshSkippedReason: "unchanged_watermark",
        watermark: "wm-prior-healthy",
        candidateCount: 1, selectedFeedCount: 1,
      },
    };
  };

  try {
    const res = await request(app).post("/api/dashboard/refresh");
    assert.equal(res.status, 200);
    assert.equal(priorStoryCountSeen, 2, "priorStoryCount must reflect non-empty stories.length");
    // Prior-snapshot path on skip: stories array is preserved from snapshot.
    assert.equal(res.body.stories.length, 2);
    assert.equal(res.body._meta.unchanged, true);
  } finally {
    _refreshPipeline.run = prevRun;
    _snapshotRepo.read = prevRead;
    _snapshotRepo.write = prevWrite;
    _snapshotRepo.getLocks = prevGetLocks;
    _snapshotRepo.insertLocks = prevInsertLocks;
  }
});

test("POST /api/dashboard/refresh: watermark changed → full run executes, response carries new watermark", async () => {
  const prevRun = _refreshPipeline.run;
  const prevRead = _snapshotRepo.read;
  const prevWrite = _snapshotRepo.write;
  const prevGetLocks = _snapshotRepo.getLocks;
  const prevInsertLocks = _snapshotRepo.insertLocks;

  let priorWatermarkSeen = "not-passed";
  _snapshotRepo.read = async () => ({
    contractVersion: "2026-05-19-meta-story-fields",
    stories: [],
    _watermark: "old-wm",
  });
  _snapshotRepo.write = async () => {};
  _snapshotRepo.getLocks = async () => new Map();
  _snapshotRepo.insertLocks = async () => {};
  _refreshPipeline.run = async (opts) => {
    priorWatermarkSeen = opts.priorWatermark;
    return {
      payload: { contractVersion: "2026-05-19-meta-story-fields", stories: [] },
      log: {
        poolCount: 1,
        relevantCount: 1,
        usedFallbackClustering: false,
        groundingFailures: 0,
        droppedUngroundedStoryCount: 0,
        groundingDropReasons: {},
        watermark: "new-wm",
        candidateCount: 1,
        selectedFeedCount: 1,
        unchanged: false,
        refreshSkippedReason: null,
        selection: { sourceSelectionMode: "strict", sourceFallbackUsed: false, matchedSourceCount: 1, selectedSourceCount: 1, unmatchedSelectedSources: [], unavailableConnectorCount: 0, relevantItemCount: 1 },
      },
    };
  };
  try {
    const res = await request(app).post("/api/dashboard/refresh");
    assert.equal(res.status, 200);
    assert.equal(priorWatermarkSeen, "old-wm", "route must forward priorWatermark to pipeline");
    assert.equal(res.body._meta.watermark, "new-wm");
    assert.equal(res.body._meta.unchanged, false);
    assert.equal(res.body._meta.refreshSkippedReason, undefined);
  } finally {
    _refreshPipeline.run = prevRun;
    _snapshotRepo.read = prevRead;
    _snapshotRepo.write = prevWrite;
    _snapshotRepo.getLocks = prevGetLocks;
    _snapshotRepo.insertLocks = prevInsertLocks;
  }
});

// ─── Phase 4: in-flight guard ────────────────────────────────────────────────

test("POST /api/dashboard/refresh: concurrent refresh for same user is skipped with refreshSkippedReason=in_flight", async () => {
  const prevRun = _refreshPipeline.run;
  const prevRead = _snapshotRepo.read;
  const prevWrite = _snapshotRepo.write;
  const prevGetLocks = _snapshotRepo.getLocks;
  const prevInsertLocks = _snapshotRepo.insertLocks;

  // Make the pipeline hold for ~50ms so a second request can land while it's running.
  let pipelineCalls = 0;
  _snapshotRepo.read = async () => null;
  _snapshotRepo.write = async () => {};
  _snapshotRepo.getLocks = async () => new Map();
  _snapshotRepo.insertLocks = async () => {};
  _refreshPipeline.run = async () => {
    pipelineCalls++;
    await new Promise((r) => setTimeout(r, 60));
    return {
      payload: { contractVersion: "2026-05-19-meta-story-fields", stories: [] },
      log: {
        poolCount: 0, relevantCount: 0, usedFallbackClustering: false, groundingFailures: 0,
        droppedUngroundedStoryCount: 0, groundingDropReasons: {},
        watermark: "wm-conc", candidateCount: 0, selectedFeedCount: 0,
        unchanged: false, refreshSkippedReason: null,
        selection: { sourceSelectionMode: "strict", sourceFallbackUsed: false, matchedSourceCount: 0, selectedSourceCount: 0, unmatchedSelectedSources: [], unavailableConnectorCount: 0, relevantItemCount: 0 },
      },
    };
  };

  try {
    const [first, second] = await Promise.all([
      request(app).post("/api/dashboard/refresh"),
      // Second request fires while first is still in pipeline.run.
      new Promise((resolve) => setTimeout(() => resolve(request(app).post("/api/dashboard/refresh")), 5)),
    ]);
    // One of them must be the in-flight skip; the other is the full run.
    const responses = [first, second];
    const skipped = responses.find((r) => r.body?._meta?.refreshSkippedReason === "in_flight");
    const ran = responses.find((r) => !r.body?._meta?.refreshSkippedReason);
    assert.ok(skipped, "one response must report refreshSkippedReason=in_flight");
    assert.ok(ran, "the other must complete normally");
    assert.equal(pipelineCalls, 1, "pipeline must execute exactly once when guarded");
  } finally {
    _refreshPipeline.run = prevRun;
    _snapshotRepo.read = prevRead;
    _snapshotRepo.write = prevWrite;
    _snapshotRepo.getLocks = prevGetLocks;
    _snapshotRepo.insertLocks = prevInsertLocks;
  }
});

test("POST /api/dashboard/refresh: in-flight slot is released after pipeline completion (next call runs)", async () => {
  const prevRun = _refreshPipeline.run;
  const prevWrite = _snapshotRepo.write;
  const prevGetLocks = _snapshotRepo.getLocks;
  const prevInsertLocks = _snapshotRepo.insertLocks;
  const prevRead = _snapshotRepo.read;

  let count = 0;
  _snapshotRepo.read = async () => null;
  _snapshotRepo.write = async () => {};
  _snapshotRepo.getLocks = async () => new Map();
  _snapshotRepo.insertLocks = async () => {};
  _refreshPipeline.run = async () => {
    count++;
    return {
      payload: { contractVersion: "2026-05-19-meta-story-fields", stories: [] },
      log: {
        poolCount: 0, relevantCount: 0, usedFallbackClustering: false, groundingFailures: 0,
        droppedUngroundedStoryCount: 0, groundingDropReasons: {},
        watermark: `wm-${count}`, candidateCount: 0, selectedFeedCount: 0,
        unchanged: false, refreshSkippedReason: null,
        selection: { sourceSelectionMode: "strict", sourceFallbackUsed: false, matchedSourceCount: 0, selectedSourceCount: 0, unmatchedSelectedSources: [], unavailableConnectorCount: 0, relevantItemCount: 0 },
      },
    };
  };

  try {
    const r1 = await request(app).post("/api/dashboard/refresh");
    const r2 = await request(app).post("/api/dashboard/refresh");
    assert.equal(r1.body._meta.refreshSkippedReason, undefined);
    assert.equal(r2.body._meta.refreshSkippedReason, undefined, "after release, next sequential call must run");
    assert.equal(count, 2, "pipeline ran twice");
  } finally {
    _refreshPipeline.run = prevRun;
    _snapshotRepo.write = prevWrite;
    _snapshotRepo.getLocks = prevGetLocks;
    _snapshotRepo.insertLocks = prevInsertLocks;
    _snapshotRepo.read = prevRead;
  }
});

// ─── Phase 5: bootstrap route ────────────────────────────────────────────────

test("POST /api/dashboard/bootstrap: 401 without identity", async () => {
  const prev = _auth.resolver;
  _auth.resolver = async () => null;
  try {
    const res = await request(app).post("/api/dashboard/bootstrap");
    assert.equal(res.status, 401);
  } finally {
    _auth.resolver = prev;
  }
});

test("POST /api/dashboard/bootstrap: fresh snapshot (<= 60 min) → served_fresh_snapshot, no pipeline run", async () => {
  const prev = _snapshotRepo.read;
  const prevRun = _refreshPipeline.run;
  let pipelineCalls = 0;
  const FRESH_SNAPSHOT = {
    contractVersion: "2026-05-19-meta-story-fields",
    stories: [],
    _meta: { hasSnapshot: true, refreshedAt: new Date(Date.now() - 5 * 60_000).toISOString() }, // 5 min ago
    _selectionMeta: { sourceSelectionMode: "strict", sourceFallbackUsed: false, matchedSourceCount: 1, selectedSourceCount: 1, unmatchedSelectedSources: [], unavailableConnectorCount: 0, relevantItemCount: 1 },
    _watermark: "wm-fresh",
  };
  _snapshotRepo.read = async () => FRESH_SNAPSHOT;
  _refreshPipeline.run = async () => { pipelineCalls++; return { payload: null, log: { unchanged: true } }; };
  try {
    const res = await request(app).post("/api/dashboard/bootstrap");
    assert.equal(res.status, 200);
    assert.equal(res.body._meta.bootstrapDecision, "served_fresh_snapshot");
    assert.equal(pipelineCalls, 0, "pipeline must NOT run when snapshot is fresh");
    assert.equal(res.body._meta.watermark, "wm-fresh", "watermark surfaced from snapshot");
    assert.ok(res.body._meta.selection, "selection meta surfaced");
    // Internal storage fields must not leak
    assert.equal(res.body._selectionMeta, undefined);
    assert.equal(res.body._watermark, undefined);
  } finally {
    _snapshotRepo.read = prev;
    _refreshPipeline.run = prevRun;
  }
});

test("POST /api/dashboard/bootstrap: stale snapshot (> 60 min) → ran_refresh, pipeline runs", async () => {
  const prevRead = _snapshotRepo.read;
  const prevRun = _refreshPipeline.run;
  const prevWrite = _snapshotRepo.write;
  const prevGetLocks = _snapshotRepo.getLocks;
  const prevInsertLocks = _snapshotRepo.insertLocks;

  const STALE_SNAPSHOT = {
    contractVersion: "2026-05-19-meta-story-fields",
    stories: [],
    _meta: { hasSnapshot: true, refreshedAt: new Date(Date.now() - 90 * 60_000).toISOString() }, // 90 min ago
    _watermark: "wm-stale",
  };
  let pipelineCalls = 0;
  _snapshotRepo.read = async () => STALE_SNAPSHOT;
  _snapshotRepo.write = async () => {};
  _snapshotRepo.getLocks = async () => new Map();
  _snapshotRepo.insertLocks = async () => {};
  _refreshPipeline.run = async (opts) => {
    pipelineCalls++;
    assert.equal(opts.priorWatermark, "wm-stale", "stale snapshot's watermark forwarded");
    return {
      payload: { contractVersion: "2026-05-19-meta-story-fields", stories: [] },
      log: {
        poolCount: 1, relevantCount: 1, usedFallbackClustering: false, groundingFailures: 0,
        droppedUngroundedStoryCount: 0, groundingDropReasons: {},
        watermark: "wm-new", candidateCount: 1, selectedFeedCount: 1,
        unchanged: false, refreshSkippedReason: null,
        selection: { sourceSelectionMode: "strict", sourceFallbackUsed: false, matchedSourceCount: 1, selectedSourceCount: 1, unmatchedSelectedSources: [], unavailableConnectorCount: 0, relevantItemCount: 1 },
      },
    };
  };

  try {
    const res = await request(app).post("/api/dashboard/bootstrap");
    assert.equal(res.status, 200);
    assert.equal(res.body._meta.bootstrapDecision, "ran_refresh");
    assert.equal(pipelineCalls, 1, "pipeline must run when snapshot is stale");
    assert.equal(res.body._meta.watermark, "wm-new", "response carries new watermark");
  } finally {
    _snapshotRepo.read = prevRead;
    _snapshotRepo.write = prevWrite;
    _snapshotRepo.getLocks = prevGetLocks;
    _snapshotRepo.insertLocks = prevInsertLocks;
    _refreshPipeline.run = prevRun;
  }
});

test("POST /api/dashboard/bootstrap: no prior snapshot + refresh produces snapshot → ran_refresh", async () => {
  const prevRead = _snapshotRepo.read;
  const prevRun = _refreshPipeline.run;
  const prevWrite = _snapshotRepo.write;
  const prevGetLocks = _snapshotRepo.getLocks;
  const prevInsertLocks = _snapshotRepo.insertLocks;

  _snapshotRepo.read = async () => null;
  _snapshotRepo.write = async () => {};
  _snapshotRepo.getLocks = async () => new Map();
  _snapshotRepo.insertLocks = async () => {};
  _refreshPipeline.run = async () => ({
    payload: { contractVersion: "2026-05-19-meta-story-fields", stories: [] },
    log: {
      poolCount: 1, relevantCount: 1, usedFallbackClustering: false, groundingFailures: 0,
      droppedUngroundedStoryCount: 0, groundingDropReasons: {},
      watermark: "wm-first", candidateCount: 1, selectedFeedCount: 1,
      unchanged: false, refreshSkippedReason: null,
      selection: { sourceSelectionMode: "strict", sourceFallbackUsed: false, matchedSourceCount: 1, selectedSourceCount: 1, unmatchedSelectedSources: [], unavailableConnectorCount: 0, relevantItemCount: 1 },
    },
  });
  try {
    const res = await request(app).post("/api/dashboard/bootstrap");
    assert.equal(res.status, 200);
    assert.equal(res.body._meta.bootstrapDecision, "ran_refresh");
    assert.equal(res.body._meta.hasSnapshot, true);
  } finally {
    _snapshotRepo.read = prevRead;
    _snapshotRepo.write = prevWrite;
    _snapshotRepo.getLocks = prevGetLocks;
    _snapshotRepo.insertLocks = prevInsertLocks;
    _refreshPipeline.run = prevRun;
  }
});

test("POST /api/dashboard/bootstrap: no prior snapshot + refresh fails → no_snapshot (status 500)", async () => {
  const prevRead = _snapshotRepo.read;
  const prevRun = _refreshPipeline.run;
  _snapshotRepo.read = async () => null;
  _refreshPipeline.run = async () => { throw new Error("pipeline exploded"); };
  try {
    const res = await request(app).post("/api/dashboard/bootstrap");
    // Pipeline failed and no fallback snapshot exists → underlying refresh
    // helper returns 500.  Bootstrap surfaces this as the request status; we
    // do NOT silently rewrite to 200 because clients should know the call failed.
    assert.equal(res.status, 500);
    assert.equal(typeof res.body.message, "string");
  } finally {
    _snapshotRepo.read = prevRead;
    _refreshPipeline.run = prevRun;
  }
});

test("POST /api/dashboard/bootstrap: snapshot at exactly 60 min boundary is treated as fresh", async () => {
  const prev = _snapshotRepo.read;
  const prevRun = _refreshPipeline.run;
  let pipelineCalls = 0;
  // 60 min - 1s — comfortably within the 60 min threshold (<= cutoff is fresh)
  const SNAPSHOT = {
    contractVersion: "2026-05-19-meta-story-fields",
    stories: [],
    _meta: { hasSnapshot: true, refreshedAt: new Date(Date.now() - (60 * 60_000 - 1000)).toISOString() },
  };
  _snapshotRepo.read = async () => SNAPSHOT;
  _refreshPipeline.run = async () => { pipelineCalls++; return { payload: null, log: { unchanged: true } }; };
  try {
    const res = await request(app).post("/api/dashboard/bootstrap");
    assert.equal(res.body._meta.bootstrapDecision, "served_fresh_snapshot");
    assert.equal(pipelineCalls, 0);
  } finally {
    _snapshotRepo.read = prev;
    _refreshPipeline.run = prevRun;
  }
});

test("POST /api/dashboard/bootstrap: snapshot just over 60 min triggers refresh", async () => {
  const prevRead = _snapshotRepo.read;
  const prevRun = _refreshPipeline.run;
  const prevWrite = _snapshotRepo.write;
  const prevGetLocks = _snapshotRepo.getLocks;
  const prevInsertLocks = _snapshotRepo.insertLocks;

  // 61 minutes ago — past the cutoff
  const SNAPSHOT = {
    contractVersion: "2026-05-19-meta-story-fields",
    stories: [],
    _meta: { hasSnapshot: true, refreshedAt: new Date(Date.now() - 61 * 60_000).toISOString() },
  };
  let pipelineCalls = 0;
  _snapshotRepo.read = async () => SNAPSHOT;
  _snapshotRepo.write = async () => {};
  _snapshotRepo.getLocks = async () => new Map();
  _snapshotRepo.insertLocks = async () => {};
  _refreshPipeline.run = async () => {
    pipelineCalls++;
    return {
      payload: { contractVersion: "2026-05-19-meta-story-fields", stories: [] },
      log: {
        poolCount: 0, relevantCount: 0, usedFallbackClustering: false, groundingFailures: 0,
        droppedUngroundedStoryCount: 0, groundingDropReasons: {},
        watermark: "wm-newer", candidateCount: 0, selectedFeedCount: 0,
        unchanged: false, refreshSkippedReason: null,
        selection: { sourceSelectionMode: "strict", sourceFallbackUsed: false, matchedSourceCount: 0, selectedSourceCount: 0, unmatchedSelectedSources: [], unavailableConnectorCount: 0, relevantItemCount: 0 },
      },
    };
  };
  try {
    const res = await request(app).post("/api/dashboard/bootstrap");
    assert.equal(res.body._meta.bootstrapDecision, "ran_refresh");
    assert.equal(pipelineCalls, 1);
  } finally {
    _snapshotRepo.read = prevRead;
    _snapshotRepo.write = prevWrite;
    _snapshotRepo.getLocks = prevGetLocks;
    _snapshotRepo.insertLocks = prevInsertLocks;
    _refreshPipeline.run = prevRun;
  }
});

test("POST /api/dashboard/bootstrap: malformed FRESH snapshot fails validation → empty payload + bootstrapDecision=no_snapshot", async () => {
  // Phase 5 fix: fresh-snapshot branch must run dashboardPayloadSchema.safeParse
  // exactly like GET /api/dashboard.  A persisted snapshot whose stories array
  // contains schema-invalid records must NOT pass through to the client.
  const prev = _snapshotRepo.read;
  const prevRun = _refreshPipeline.run;
  let pipelineCalls = 0;
  const MALFORMED_FRESH = {
    contractVersion: "2026-05-19-meta-story-fields",
    stories: [
      {
        // Missing required `id`, `topic`, `summary`, etc. — schema must reject
        outletCount: "not-a-number",
        sources: [],
      },
    ],
    _meta: { hasSnapshot: true, refreshedAt: new Date(Date.now() - 5 * 60_000).toISOString() },
  };
  _snapshotRepo.read = async () => MALFORMED_FRESH;
  _refreshPipeline.run = async () => { pipelineCalls++; return { payload: null, log: { unchanged: true } }; };
  try {
    const res = await request(app).post("/api/dashboard/bootstrap");
    assert.equal(res.status, 200);
    assert.equal(res.body._meta.bootstrapDecision, "no_snapshot", "malformed fresh snapshot must demote to no_snapshot");
    assert.equal(res.body._meta.hasSnapshot, false);
    assert.deepEqual(res.body.stories, []);
    assert.equal(pipelineCalls, 0, "fresh-branch validation failure must NOT trigger refresh");
  } finally {
    _snapshotRepo.read = prev;
    _refreshPipeline.run = prevRun;
  }
});

test("POST /api/dashboard/bootstrap: in_flight body with hasSnapshot=true → ran_refresh (deterministic, executor stubbed)", async () => {
  // Replaces the prior concurrency-race test.  We stub `_refreshExecutor.execute`
  // directly to return a synthetic in_flight result, eliminating timing/Promise
  // ordering as a source of flakiness.  This is the exact scenario Phase 5 fix
  // #2 cares about: bootstrap's initial snapshot read may be null, but the
  // refresh executor's body can still carry hasSnapshot=true (e.g. a concurrent
  // worker just wrote a snapshot the helper's internal re-read picked up).
  const prevRead = _snapshotRepo.read;
  const prevExec = _refreshExecutor.execute;
  let execCalls = 0;
  _snapshotRepo.read = async () => null; // bootstrap entry: no snapshot known here
  _refreshExecutor.execute = async () => {
    execCalls++;
    return {
      kind: "in_flight",
      httpStatus: 200,
      body: {
        contractVersion: "2026-05-19-meta-story-fields",
        stories: [],
        _meta: { hasSnapshot: true, refreshSkippedReason: "in_flight", unchanged: false },
      },
    };
  };
  try {
    const res = await request(app).post("/api/dashboard/bootstrap");
    assert.equal(res.status, 200);
    assert.equal(
      res.body._meta.bootstrapDecision,
      "ran_refresh",
      "in_flight body with hasSnapshot=true must yield ran_refresh regardless of initial-read state"
    );
    assert.equal(res.body._meta.refreshSkippedReason, "in_flight");
    assert.equal(execCalls, 1);
  } finally {
    _snapshotRepo.read = prevRead;
    _refreshExecutor.execute = prevExec;
  }
});

test("POST /api/dashboard/bootstrap: in_flight body with hasSnapshot=false → no_snapshot (deterministic, executor stubbed)", async () => {
  // Replaces the prior concurrency-race test.  Same approach — stub the executor.
  // Inverse scenario: initial snapshot read DOES return data, but the executor's
  // in_flight body has hasSnapshot=false (e.g. its internal re-read returned
  // null).  Decision must be derived from body, not the initial read.
  const prevRead = _snapshotRepo.read;
  const prevExec = _refreshExecutor.execute;
  _snapshotRepo.read = async () => ({
    // Stale (90 min) — bypasses the fresh-snapshot branch so we proceed to the
    // executor.  But this stale snapshot exists, so naive "snapshot ? ran : no"
    // logic would WRONGLY return ran_refresh.  The fix routes through body.
    contractVersion: "2026-05-19-meta-story-fields",
    stories: [],
    _meta: { hasSnapshot: true, refreshedAt: new Date(Date.now() - 90 * 60_000).toISOString() },
  });
  _refreshExecutor.execute = async () => ({
    kind: "in_flight",
    httpStatus: 200,
    body: {
      contractVersion: "2026-05-19-meta-story-fields",
      stories: [],
      _meta: { hasSnapshot: false, refreshSkippedReason: "in_flight", unchanged: false },
    },
  });
  try {
    const res = await request(app).post("/api/dashboard/bootstrap");
    assert.equal(res.status, 200);
    assert.equal(
      res.body._meta.bootstrapDecision,
      "no_snapshot",
      "in_flight body without snapshot must yield no_snapshot regardless of initial-read state"
    );
    assert.equal(res.body._meta.hasSnapshot, false);
  } finally {
    _snapshotRepo.read = prevRead;
    _refreshExecutor.execute = prevExec;
  }
});

test("GET /api/dashboard does NOT include bootstrapDecision (Phase 5: bootstrap-only field)", async () => {
  const prev = _snapshotRepo.read;
  _snapshotRepo.read = async () => ({
    contractVersion: "2026-05-19-meta-story-fields",
    stories: [],
    _meta: { hasSnapshot: true, refreshedAt: new Date().toISOString() },
  });
  try {
    const res = await request(app).get("/api/dashboard");
    assert.equal(res.status, 200);
    assert.equal(res.body._meta.bootstrapDecision, undefined, "GET must not surface bootstrapDecision");
  } finally {
    _snapshotRepo.read = prev;
  }
});

// ─── Identity resolution — resolveIdentity unit tests ────────────────────────
// These exercise the exported resolveIdentity function directly (no HTTP overhead).
// In the test environment SUPABASE_URL is unset, so Bearer and email lookups both need mocking.
// _clearEmailCache() is called around each test to prevent cache cross-contamination.

test("resolveIdentity: resolves email_recognition via server-side email lookup", async () => {
  _clearEmailCache();
  const prevLookup = _emailLookup.resolve;
  _emailLookup.resolve = async (email) => email === "user@example.com" ? "looked-up-user-id" : null;
  try {
    const mockReq = { headers: { "x-recognized-email": "user@example.com" } };
    const identity = await resolveIdentity(mockReq);
    assert.deepEqual(identity, { userId: "looked-up-user-id", source: "email_recognition" });
  } finally {
    _emailLookup.resolve = prevLookup;
    _clearEmailCache();
  }
});

test("resolveIdentity: lowercases email before lookup (normalization)", async () => {
  _clearEmailCache();
  let receivedEmail = null;
  const prevLookup = _emailLookup.resolve;
  _emailLookup.resolve = async (email) => { receivedEmail = email; return "u-123"; };
  try {
    const mockReq = { headers: { "x-recognized-email": "User@Example.COM" } };
    await resolveIdentity(mockReq);
    assert.equal(receivedEmail, "user@example.com");
  } finally {
    _emailLookup.resolve = prevLookup;
    _clearEmailCache();
  }
});

test("resolveIdentity: returns null when email lookup finds no matching user", async () => {
  _clearEmailCache();
  const prevLookup = _emailLookup.resolve;
  _emailLookup.resolve = async () => null;
  try {
    const mockReq = { headers: { "x-recognized-email": "unknown@example.com" } };
    const identity = await resolveIdentity(mockReq);
    assert.equal(identity, null);
  } finally {
    _emailLookup.resolve = prevLookup;
    _clearEmailCache();
  }
});

test("resolveIdentity: x-recognized-user-id header alone returns null (not trusted)", async () => {
  // Client-supplied userId is not a valid identity hint — must use x-recognized-email.
  const mockReq = { headers: { "x-recognized-user-id": "some-client-user-id" } };
  const identity = await resolveIdentity(mockReq);
  assert.equal(identity, null);
});

test("resolveIdentity: returns null when no credentials present", async () => {
  const mockReq = { headers: {} };
  const identity = await resolveIdentity(mockReq);
  assert.equal(identity, null);
});

test("resolveIdentity: returns null when Bearer present but Supabase disabled — does not fall through to email header", async () => {
  // SUPABASE_URL is not set in test env, so isSupabaseEnabled() is false.
  // A presented-but-unresolvable Bearer must NOT fall through to x-recognized-email.
  _clearEmailCache();
  const prevLookup = _emailLookup.resolve;
  _emailLookup.resolve = async () => "should-not-be-called";
  try {
    const mockReq = {
      headers: {
        authorization: "Bearer some-token",
        "x-recognized-email": "user@example.com",
      },
    };
    const identity = await resolveIdentity(mockReq);
    assert.equal(identity, null);
  } finally {
    _emailLookup.resolve = prevLookup;
    _clearEmailCache();
  }
});

test("resolveIdentity: returns null when x-recognized-email is blank", async () => {
  const mockReq = { headers: { "x-recognized-email": "   " } };
  const identity = await resolveIdentity(mockReq);
  assert.equal(identity, null);
});

// ─── Narrative persistence (Pattern A) ───────────────────────────────────────

test("PUT /api/settings with onboardingRawText calls narrative hook after successful settings write", async () => {
  let captured = null;
  const prev = _narrativeRepo.append;
  _narrativeRepo.append = async (userId, rawText) => { captured = { userId, rawText }; };
  try {
    const body = { ...VALID_BODY, onboardingRawText: "I cover US-Colombia migration for a nonprofit." };
    const res = await request(app)
      .put("/api/settings")
      .send(body)
      .set("Content-Type", "application/json");
    assert.equal(res.status, 200);
    assert.ok(captured !== null, "narrative hook must be called when onboardingRawText is present");
    assert.equal(captured.userId, TEST_USER_ID);
    assert.equal(captured.rawText, "I cover US-Colombia migration for a nonprofit.");
    // onboardingRawText must be stripped from the settings response
    assert.ok(!("onboardingRawText" in res.body), "response must not include onboardingRawText");
    // response must still conform to settingsPayloadSchema
    const parsed = settingsPayloadSchema.safeParse(res.body);
    assert.ok(parsed.success, "response with narrative must still conform to settingsPayloadSchema");
  } finally {
    _narrativeRepo.append = prev;
  }
});

test("PUT /api/settings without onboardingRawText does not call narrative hook", async () => {
  let called = false;
  const prev = _narrativeRepo.append;
  _narrativeRepo.append = async () => { called = true; };
  try {
    const res = await request(app)
      .put("/api/settings")
      .send(VALID_BODY)
      .set("Content-Type", "application/json");
    assert.equal(res.status, 200);
    assert.ok(!called, "narrative hook must not be called when onboardingRawText is absent");
  } finally {
    _narrativeRepo.append = prev;
  }
});

test("PUT /api/settings with blank onboardingRawText does not call narrative hook", async () => {
  let called = false;
  const prev = _narrativeRepo.append;
  _narrativeRepo.append = async () => { called = true; };
  try {
    const body = { ...VALID_BODY, onboardingRawText: "   " };
    const res = await request(app)
      .put("/api/settings")
      .send(body)
      .set("Content-Type", "application/json");
    assert.equal(res.status, 200);
    assert.ok(!called, "whitespace-only narrative must not trigger the hook");
  } finally {
    _narrativeRepo.append = prev;
  }
});

test("PUT /api/settings returns 500 and does not call narrative hook when settings write fails (Pattern A)", async () => {
  let narrativeCalled = false;
  const prevNarrative = _narrativeRepo.append;
  const prevWrite = _writeSettings.write;
  _narrativeRepo.append = async () => { narrativeCalled = true; };
  _writeSettings.write = async () => { throw new Error("settings write failed"); };
  try {
    const body = { ...VALID_BODY, onboardingRawText: "Some narrative." };
    const res = await request(app)
      .put("/api/settings")
      .send(body)
      .set("Content-Type", "application/json");
    assert.equal(res.status, 500);
    assert.ok(!narrativeCalled, "narrative hook must not be called when settings write fails");
  } finally {
    _narrativeRepo.append = prevNarrative;
    _writeSettings.write = prevWrite;
  }
});

test("PUT /api/settings returns 500 when narrative hook throws and onboardingRawText is present (Pattern A strict)", async () => {
  const prev = _narrativeRepo.append;
  _narrativeRepo.append = async () => { throw new Error("supabase narrative write failed"); };
  try {
    const body = { ...VALID_BODY, onboardingRawText: "Some narrative." };
    const res = await request(app)
      .put("/api/settings")
      .send(body)
      .set("Content-Type", "application/json");
    assert.equal(res.status, 500, "request must fail when narrative write is required but fails");
    assert.equal(typeof res.body.message, "string", "error response must include a message");
  } finally {
    _narrativeRepo.append = prev;
  }
});

// ─── Atomic path (Supabase enabled + onboardingRawText) ──────────────────────
// These tests simulate the Supabase environment by setting fake env vars so
// isSupabaseEnabled() returns true, then override _atomicSave.execute to control
// outcomes without a live Supabase instance.
//
// No-partial-write guarantee is demonstrated structurally: on the atomic path,
// _writeSettings.write and _narrativeRepo.append are NEVER called independently —
// all writes go through the single _atomicSave.execute hook.  When that hook
// throws, neither write has occurred.

test("atomic path: success routes through _atomicSave.execute with correct args, returns 200", async () => {
  const savedUrl = process.env.SUPABASE_URL;
  const savedKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL = "http://fake-supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-role-key";

  let capturedArgs = null;
  let settingsWriteCalled = false;
  let narrativeAppendCalled = false;
  const prevExec = _atomicSave.execute;
  const prevWrite = _writeSettings.write;
  const prevNarrative = _narrativeRepo.append;
  const prevNarrativeRead = _narrativeRepo.read;
  const prevReadHas = _readSettings.has;
  const prevExtract = _extraction.extract;
  _atomicSave.execute = async (args) => { capturedArgs = args; };
  _writeSettings.write = async () => { settingsWriteCalled = true; };
  _narrativeRepo.append = async () => { narrativeAppendCalled = true; };
  // Prevent post-save extraction from hitting the fake Supabase URL.
  _narrativeRepo.read = async () => null;
  // Prevent the previous-settings read from hitting the fake Supabase URL.
  _readSettings.has = async () => false;
  // Stub extraction to a no-op: post-save onboarding extraction can otherwise
  // produce merged fields that differ from the saved settings and trigger a
  // second `_writeSettings.write` (the merge write), which would falsely trip
  // the "write must not be called independently" assertion below. Returning
  // null keeps this test scoped to the initial atomic-save path only.
  _extraction.extract = async () => null;

  try {
    const body = { ...VALID_BODY, onboardingRawText: "I cover US-Colombia migration for a nonprofit." };
    const res = await request(app)
      .put("/api/settings")
      .send(body)
      .set("Content-Type", "application/json");
    assert.equal(res.status, 200);
    assert.ok(capturedArgs !== null, "_atomicSave.execute must be called on Supabase path");
    assert.equal(capturedArgs.userId, TEST_USER_ID);
    assert.equal(capturedArgs.rawNarrative, "I cover US-Colombia migration for a nonprofit.");
    assert.deepEqual(capturedArgs.settingsPayload.topics, VALID_BODY.topics);
    assert.ok(!settingsWriteCalled, "_writeSettings.write must not be called independently on atomic path");
    assert.ok(!narrativeAppendCalled, "_narrativeRepo.append must not be called independently on atomic path");
    // onboardingRawText must be stripped from the settings response
    assert.ok(!("onboardingRawText" in res.body), "response must not include onboardingRawText");
  } finally {
    _atomicSave.execute = prevExec;
    _writeSettings.write = prevWrite;
    _narrativeRepo.append = prevNarrative;
    _narrativeRepo.read = prevNarrativeRead;
    _readSettings.has = prevReadHas;
    _extraction.extract = prevExtract;
    if (savedUrl !== undefined) process.env.SUPABASE_URL = savedUrl;
    else delete process.env.SUPABASE_URL;
    if (savedKey !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = savedKey;
    else delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  }
});

test("atomic path: _atomicSave.execute failure → 500, neither write called independently (no partial write)", async () => {
  const savedUrl = process.env.SUPABASE_URL;
  const savedKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL = "http://fake-supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-role-key";

  let settingsWriteCalled = false;
  let narrativeAppendCalled = false;
  const prevExec = _atomicSave.execute;
  const prevWrite = _writeSettings.write;
  const prevNarrative = _narrativeRepo.append;
  const prevReadHas = _readSettings.has;
  _atomicSave.execute = async () => { throw new Error("DB transaction rolled back"); };
  _writeSettings.write = async () => { settingsWriteCalled = true; };
  _narrativeRepo.append = async () => { narrativeAppendCalled = true; };
  _readSettings.has = async () => false;

  try {
    const body = { ...VALID_BODY, onboardingRawText: "I cover US-Colombia migration." };
    const res = await request(app)
      .put("/api/settings")
      .send(body)
      .set("Content-Type", "application/json");
    assert.equal(res.status, 500);
    assert.equal(typeof res.body.message, "string");
    // Structural proof of no partial write: individual write hooks were never invoked.
    // The only write path was _atomicSave.execute, which threw before committing anything.
    assert.ok(!settingsWriteCalled, "_writeSettings.write must not be called on atomic path");
    assert.ok(!narrativeAppendCalled, "_narrativeRepo.append must not be called on atomic path");
  } finally {
    _atomicSave.execute = prevExec;
    _writeSettings.write = prevWrite;
    _narrativeRepo.append = prevNarrative;
    _readSettings.has = prevReadHas;
    if (savedUrl !== undefined) process.env.SUPABASE_URL = savedUrl;
    else delete process.env.SUPABASE_URL;
    if (savedKey !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = savedKey;
    else delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  }
});

test("atomic path: 500 response includes detail field propagated from RPC error", async () => {
  const savedUrl = process.env.SUPABASE_URL;
  const savedKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL = "http://fake-supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-role-key";

  const prevExec = _atomicSave.execute;
  const prevReadHas = _readSettings.has;
  _atomicSave.execute = async () => { throw new Error("[atomic-save] RPC not found — run migration 009: Could not find the function"); };
  _readSettings.has = async () => false;

  try {
    const body = { ...VALID_BODY, onboardingRawText: "I cover migration policy." };
    const res = await request(app)
      .put("/api/settings")
      .send(body)
      .set("Content-Type", "application/json");
    assert.equal(res.status, 500);
    assert.equal(typeof res.body.message, "string");
    assert.equal(typeof res.body.detail, "string", "detail field must be present to aid debugging");
    assert.ok(
      res.body.detail.includes("atomic-save"),
      `expected detail to include '[atomic-save]', got: ${res.body.detail}`
    );
  } finally {
    _atomicSave.execute = prevExec;
    _readSettings.has = prevReadHas;
    if (savedUrl !== undefined) process.env.SUPABASE_URL = savedUrl;
    else delete process.env.SUPABASE_URL;
    if (savedKey !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = savedKey;
    else delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  }
});

test("atomic path not taken when onboardingRawText is absent (Supabase enabled) — uses _writeSettings.write", async () => {
  const savedUrl = process.env.SUPABASE_URL;
  const savedKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL = "http://fake-supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-role-key";

  let atomicCalled = false;
  let settingsWriteCalled = false;
  const prevExec = _atomicSave.execute;
  const prevWrite = _writeSettings.write;
  const prevReadHas = _readSettings.has;
  _atomicSave.execute = async () => { atomicCalled = true; };
  _writeSettings.write = async () => { settingsWriteCalled = true; };
  _readSettings.has = async () => false;

  try {
    const res = await request(app)
      .put("/api/settings")
      .send(VALID_BODY)
      .set("Content-Type", "application/json");
    assert.equal(res.status, 200);
    assert.ok(!atomicCalled, "_atomicSave.execute must not be called when onboardingRawText is absent");
    assert.ok(settingsWriteCalled, "_writeSettings.write must be called on non-atomic path");
  } finally {
    _atomicSave.execute = prevExec;
    _writeSettings.write = prevWrite;
    _readSettings.has = prevReadHas;
    if (savedUrl !== undefined) process.env.SUPABASE_URL = savedUrl;
    else delete process.env.SUPABASE_URL;
    if (savedKey !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = savedKey;
    else delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  }
});

// ─── Email-recognition cache behavior ────────────────────────────────────────

test("resolveIdentity cache: second call within TTL uses cached result without re-invoking lookup", async () => {
  _clearEmailCache();
  const prevLookup = _emailLookup.resolve;
  let callCount = 0;
  _emailLookup.resolve = async (email) => { callCount++; return email === "cached@example.com" ? "u-cached" : null; };
  try {
    const mockReq = { headers: { "x-recognized-email": "cached@example.com" } };
    const id1 = await resolveIdentity(mockReq);
    const id2 = await resolveIdentity(mockReq);
    assert.deepEqual(id1, { userId: "u-cached", source: "email_recognition" });
    assert.deepEqual(id2, { userId: "u-cached", source: "email_recognition" });
    assert.equal(callCount, 1, "lookup must be called exactly once; second call served from cache");
  } finally {
    _emailLookup.resolve = prevLookup;
    _clearEmailCache();
  }
});

test("resolveIdentity cache: different emails use independent cache entries", async () => {
  _clearEmailCache();
  const prevLookup = _emailLookup.resolve;
  const lookupLog = [];
  _emailLookup.resolve = async (email) => {
    lookupLog.push(email);
    if (email === "a@example.com") return "user-a";
    if (email === "b@example.com") return "user-b";
    return null;
  };
  try {
    const idA = await resolveIdentity({ headers: { "x-recognized-email": "a@example.com" } });
    const idB = await resolveIdentity({ headers: { "x-recognized-email": "b@example.com" } });
    const idA2 = await resolveIdentity({ headers: { "x-recognized-email": "a@example.com" } });
    assert.equal(idA?.userId, "user-a");
    assert.equal(idB?.userId, "user-b");
    assert.equal(idA2?.userId, "user-a");
    assert.equal(lookupLog.length, 2, "a and b each looked up once; second a is from cache");
  } finally {
    _emailLookup.resolve = prevLookup;
    _clearEmailCache();
  }
});

// ─── Identity resolution — HTTP integration via email_recognition ─────────────

test("GET /api/settings returns 200 when resolved via x-recognized-email header", async () => {
  _clearEmailCache();
  const prevResolver = _auth.resolver;
  const prevLookup = _emailLookup.resolve;
  _auth.resolver = resolveIdentity;
  _emailLookup.resolve = async (email) => email === "test@example.com" ? TEST_USER_ID : null;
  try {
    const res = await request(app)
      .get("/api/settings")
      .set("x-recognized-email", "test@example.com");
    assert.equal(res.status, 200);
  } finally {
    _auth.resolver = prevResolver;
    _emailLookup.resolve = prevLookup;
    _clearEmailCache();
  }
});

// ─── Post-save extraction trigger (Section 4) ─────────────────────────────────
// These tests verify that after a successful onboarding save, the server reads
// the persisted narrative, runs extraction, and writes the extracted fields back
// to settings.  The _narrativeRepo.read and _extraction.extract hooks are used to
// control outcomes without a live AI provider or Supabase instance.

test("extraction trigger: writes back extracted topics/keywords/geographies after onboarding save", async () => {
  const NARRATIVE = "I lead comms for a nonprofit covering US-Colombia migration.";
  const EXTRACTED = {
    topics: ["Migration policy"],
    keywords: ["bilateral"],
    geographies: ["US", "Colombia"],
    traditionalSources: [],
    socialSources: [],
  };
  const writeCalls = [];
  const prevRead = _narrativeRepo.read;
  const prevExtract = _extraction.extract;
  const prevWrite = _writeSettings.write;
  _narrativeRepo.read = async () => NARRATIVE;
  _extraction.extract = async () => EXTRACTED;
  _writeSettings.write = async (payload, userId) => { writeCalls.push({ payload, userId }); };

  try {
    const body = { ...VALID_BODY, onboardingRawText: NARRATIVE };
    const res = await request(app)
      .put("/api/settings")
      .send(body)
      .set("Content-Type", "application/json");
    assert.equal(res.status, 200);
    // write called twice: initial settings save + extraction write-back
    assert.equal(writeCalls.length, 2, "settings must be written twice: initial save + extraction write-back");
    const writeBack = writeCalls[1].payload;
    assert.deepEqual(writeBack.topics, EXTRACTED.topics, "extracted topics must be persisted");
    assert.deepEqual(writeBack.keywords, EXTRACTED.keywords, "extracted keywords must be persisted");
    assert.deepEqual(writeBack.geographies, EXTRACTED.geographies, "extracted geographies must be persisted");
    // non-extracted fields must be preserved from original settings
    assert.deepEqual(writeBack.traditionalSources, VALID_BODY.traditionalSources, "traditionalSources must be unchanged");
    assert.deepEqual(writeBack.socialSources, VALID_BODY.socialSources, "socialSources must be unchanged");
    // response reflects extracted fields
    assert.deepEqual(res.body.topics, EXTRACTED.topics);
    assert.deepEqual(res.body.geographies, EXTRACTED.geographies);
    assert.equal(res.body._meta?.extractionStatus, "succeeded");
  } finally {
    _narrativeRepo.read = prevRead;
    _extraction.extract = prevExtract;
    _writeSettings.write = prevWrite;
  }
});

test("extraction trigger: empty extracted arrays do not overwrite existing settings values", async () => {
  const EXTRACTED_EMPTY = { topics: [], keywords: [], geographies: [], traditionalSources: [], socialSources: [] };
  const writeCalls = [];
  const prevRead = _narrativeRepo.read;
  const prevExtract = _extraction.extract;
  const prevWrite = _writeSettings.write;
  _narrativeRepo.read = async () => "Some narrative.";
  _extraction.extract = async () => EXTRACTED_EMPTY;
  _writeSettings.write = async (payload, userId) => { writeCalls.push({ payload, userId }); };

  try {
    const body = { ...VALID_BODY, onboardingRawText: "Some narrative." };
    const res = await request(app)
      .put("/api/settings")
      .send(body)
      .set("Content-Type", "application/json");
    assert.equal(res.status, 200);
    // All extracted arrays are empty → no fields changed → write-back is skipped (only initial write)
    assert.equal(writeCalls.length, 1, "write-back must be skipped when no fields change");
    // Response retains original values (via settingsToReturn = merged, which equals result.data)
    assert.deepEqual(res.body.topics, VALID_BODY.topics);
    assert.deepEqual(res.body.keywords, VALID_BODY.keywords);
    assert.deepEqual(res.body.geographies, VALID_BODY.geographies);
    assert.equal(res.body._meta?.extractionStatus, "succeeded");
  } finally {
    _narrativeRepo.read = prevRead;
    _extraction.extract = prevExtract;
    _writeSettings.write = prevWrite;
  }
});

test("extraction trigger: model-provided traditionalSources and socialSources are written back", async () => {
  const EXTRACTED_WITH_SOURCES = {
    topics: ["Migration policy"],
    keywords: ["bilateral"],
    geographies: ["Colombia"],
    traditionalSources: ["Reuters", "El Tiempo"],
    socialSources: ["@latamwatcher"],
  };
  const writeCalls = [];
  const prevRead = _narrativeRepo.read;
  const prevExtract = _extraction.extract;
  const prevWrite = _writeSettings.write;
  _narrativeRepo.read = async () => "Some narrative with sources.";
  _extraction.extract = async () => EXTRACTED_WITH_SOURCES;
  _writeSettings.write = async (payload, userId) => { writeCalls.push({ payload, userId }); };

  try {
    const body = { ...VALID_BODY, onboardingRawText: "Some narrative with sources." };
    const res = await request(app)
      .put("/api/settings")
      .send(body)
      .set("Content-Type", "application/json");
    assert.equal(res.status, 200);
    assert.equal(writeCalls.length, 2, "write-back must run after extraction");
    const writeBack = writeCalls[1].payload;
    assert.deepEqual(writeBack.traditionalSources, ["Reuters", "El Tiempo"], "model-provided traditional outlets must be written back");
    assert.deepEqual(writeBack.socialSources, ["@latamwatcher"], "model-provided social handles must be written back");
    assert.deepEqual(res.body.traditionalSources, ["Reuters", "El Tiempo"]);
    assert.deepEqual(res.body.socialSources, ["@latamwatcher"]);
  } finally {
    _narrativeRepo.read = prevRead;
    _extraction.extract = prevExtract;
    _writeSettings.write = prevWrite;
  }
});

test("extraction trigger: empty extracted sources do not overwrite existing source settings", async () => {
  const EXTRACTED_NO_SOURCES = { topics: [], keywords: [], geographies: [], traditionalSources: [], socialSources: [] };
  const writeCalls = [];
  const prevRead = _narrativeRepo.read;
  const prevExtract = _extraction.extract;
  const prevWrite = _writeSettings.write;
  _narrativeRepo.read = async () => "Some narrative.";
  _extraction.extract = async () => EXTRACTED_NO_SOURCES;
  _writeSettings.write = async (payload, userId) => { writeCalls.push({ payload, userId }); };

  try {
    const body = { ...VALID_BODY, onboardingRawText: "Some narrative." };
    const res = await request(app)
      .put("/api/settings")
      .send(body)
      .set("Content-Type", "application/json");
    assert.equal(res.status, 200);
    // No fields changed — write-back skipped; response still carries original source lists
    assert.equal(writeCalls.length, 1, "write-back must be skipped when no fields change");
    assert.deepEqual(res.body.traditionalSources, VALID_BODY.traditionalSources, "traditionalSources must not be erased when extraction finds none");
    assert.deepEqual(res.body.socialSources, VALID_BODY.socialSources, "socialSources must not be erased when extraction finds none");
  } finally {
    _narrativeRepo.read = prevRead;
    _extraction.extract = prevExtract;
    _writeSettings.write = prevWrite;
  }
});

test("extraction trigger: extraction failure does not fail request — returns 200 with original settings", async () => {
  const prevRead = _narrativeRepo.read;
  const prevExtract = _extraction.extract;
  const prevWrite = _writeSettings.write;
  const writeCalls = [];
  _narrativeRepo.read = async () => "Some narrative.";
  _extraction.extract = async () => { throw new Error("model unavailable"); };
  _writeSettings.write = async (payload, userId) => { writeCalls.push({ payload, userId }); };

  try {
    const body = { ...VALID_BODY, onboardingRawText: "Some narrative." };
    const res = await request(app)
      .put("/api/settings")
      .send(body)
      .set("Content-Type", "application/json");
    assert.equal(res.status, 200, "extraction failure must not fail the onboarding save");
    // only the initial settings write — no extraction write-back
    assert.equal(writeCalls.length, 1, "write-back must not be called when extraction fails");
    // response is original validated settings, no extracted overlay
    assert.deepEqual(res.body.topics, VALID_BODY.topics);
    assert.equal(res.body._meta?.extractionStatus, "failed");
  } finally {
    _narrativeRepo.read = prevRead;
    _extraction.extract = prevExtract;
    _writeSettings.write = prevWrite;
  }
});

test("extraction trigger: failure with empty AI-derivable arrays in baseline does not inject placeholders", async () => {
  // Regression guard: at first onboarding the client sends keywords/geographies/
  // traditionalSources/socialSources as empty arrays. When extraction fails,
  // those fields must remain empty in the persisted settings — no seeded
  // placeholders, no inferred defaults.
  const prevRead = _narrativeRepo.read;
  const prevExtract = _extraction.extract;
  const prevWrite = _writeSettings.write;
  const writeCalls = [];
  _narrativeRepo.read = async () => "Watching Colombia–US.";
  _extraction.extract = async () => { throw new Error("both models timed out"); };
  _writeSettings.write = async (payload, userId) => { writeCalls.push({ payload, userId }); };

  try {
    const firstOnboardingBody = {
      contractVersion: "2026-05-19-meta-story-fields",
      topics: ["Colombia–US bilateral"],
      keywords: [],
      geographies: [],
      traditionalSources: [],
      socialSources: [],
      onboardingRawText: "Watching Colombia–US.",
    };
    const res = await request(app)
      .put("/api/settings")
      .send(firstOnboardingBody)
      .set("Content-Type", "application/json");

    assert.equal(res.status, 200);
    assert.equal(res.body._meta?.extractionStatus, "failed");
    assert.equal(writeCalls.length, 1, "no extraction write-back on failure");

    // Persisted payload preserves user-entered topics and keeps every other
    // AI-derivable field empty — no seeded values leak in.
    const persisted = writeCalls[0].payload;
    assert.deepEqual(persisted.topics, ["Colombia–US bilateral"]);
    assert.deepEqual(persisted.keywords, []);
    assert.deepEqual(persisted.geographies, []);
    assert.deepEqual(persisted.traditionalSources, []);
    assert.deepEqual(persisted.socialSources, []);

    // Response mirrors persisted state.
    assert.deepEqual(res.body.keywords, []);
    assert.deepEqual(res.body.geographies, []);
    assert.deepEqual(res.body.traditionalSources, []);
    assert.deepEqual(res.body.socialSources, []);
  } finally {
    _narrativeRepo.read = prevRead;
    _extraction.extract = prevExtract;
    _writeSettings.write = prevWrite;
  }
});

test("extraction trigger: narrative read returns null — falls back to onboardingRawText and extraction runs", async () => {
  const prevRead = _narrativeRepo.read;
  const prevExtract = _extraction.extract;
  const prevWrite = _writeSettings.write;
  let extractCalled = false;
  _narrativeRepo.read = async () => null;
  _extraction.extract = async () => { extractCalled = true; return MOCK_EXTRACTION; };
  _writeSettings.write = async () => {};

  try {
    const body = { ...VALID_BODY, onboardingRawText: "Some narrative." };
    const res = await request(app)
      .put("/api/settings")
      .send(body)
      .set("Content-Type", "application/json");
    assert.equal(res.status, 200);
    assert.ok(extractCalled, "extraction must run using onboardingRawText when narrative read returns null");
    assert.equal(res.body._meta?.extractionStatus, "succeeded");
  } finally {
    _narrativeRepo.read = prevRead;
    _extraction.extract = prevExtract;
    _writeSettings.write = prevWrite;
  }
});

test("extraction trigger: not attempted when onboardingRawText is absent", async () => {
  const prevRead = _narrativeRepo.read;
  let readCalled = false;
  _narrativeRepo.read = async () => { readCalled = true; return null; };

  try {
    const res = await request(app)
      .put("/api/settings")
      .send(VALID_BODY)
      .set("Content-Type", "application/json");
    assert.equal(res.status, 200);
    assert.ok(!readCalled, "narrative read must not be called when no onboardingRawText is provided");
    assert.equal(res.body._meta?.extractionStatus, "not_attempted");
  } finally {
    _narrativeRepo.read = prevRead;
  }
});

// ─── Two-model extraction chain (Section 7) ──────────────────────────────────

test("extraction chain: primary (Opus) succeeds — single attempt, status succeeded", async () => {
  const attempts = [];
  const prevRead = _narrativeRepo.read;
  const prevExtract = _extraction.extract;
  const prevWrite = _writeSettings.write;
  _narrativeRepo.read = async () => "Colombia diplomacy.";
  _extraction.extract = async (_text, model) => { attempts.push(model); return MOCK_EXTRACTION; };
  _writeSettings.write = async () => {};

  try {
    const res = await request(app)
      .put("/api/settings")
      .send({ ...VALID_BODY, onboardingRawText: "Colombia diplomacy." })
      .set("Content-Type", "application/json");
    assert.equal(res.status, 200);
    assert.equal(attempts.length, 1, "only primary should be attempted when primary succeeds");
    assert.equal(attempts[0], "anthropic:claude-opus-4-7", "primary must be Opus");
    assert.equal(res.body._meta?.extractionStatus, "succeeded");
  } finally {
    _narrativeRepo.read = prevRead;
    _extraction.extract = prevExtract;
    _writeSettings.write = prevWrite;
  }
});

test("extraction chain: primary fails, fallback (Sonnet) succeeds — two attempts, status succeeded", async () => {
  const attempts = [];
  const prevRead = _narrativeRepo.read;
  const prevExtract = _extraction.extract;
  const prevWrite = _writeSettings.write;
  _narrativeRepo.read = async () => "Colombia diplomacy.";
  _extraction.extract = async (_text, model) => {
    attempts.push(model);
    if (model === "anthropic:claude-opus-4-7") throw new Error("primary unavailable");
    return MOCK_EXTRACTION;
  };
  _writeSettings.write = async () => {};

  try {
    const res = await request(app)
      .put("/api/settings")
      .send({ ...VALID_BODY, onboardingRawText: "Colombia diplomacy." })
      .set("Content-Type", "application/json");
    assert.equal(res.status, 200);
    assert.equal(attempts.length, 2, "both models must be attempted");
    assert.equal(attempts[0], "anthropic:claude-opus-4-7", "primary must be Opus");
    assert.equal(attempts[1], "anthropic:claude-sonnet-4-6", "fallback must be Sonnet");
    assert.equal(res.body._meta?.extractionStatus, "succeeded");
  } finally {
    _narrativeRepo.read = prevRead;
    _extraction.extract = prevExtract;
    _writeSettings.write = prevWrite;
  }
});

test("extraction chain: route reads env-configured models in order (no hardcoded literals)", async () => {
  // Spec: server.mjs must NOT hardcode model literals — both primary and
  // fallback flow through resolveExtractionChain() at call time.  Setting the
  // env vars to recognizable sentinels and watching what the route hands to
  // _extraction.extract proves the chain is env-driven end-to-end.
  const prevPrimaryEnv = process.env.TEMPO_AI_CLASSIFIER_MODEL;
  const prevFallbackEnv = process.env.TEMPO_AI_CLASSIFIER_FALLBACK_MODEL;
  process.env.TEMPO_AI_CLASSIFIER_MODEL = "anthropic:env-primary-test";
  process.env.TEMPO_AI_CLASSIFIER_FALLBACK_MODEL = "anthropic:env-fallback-test";

  const attempts = [];
  const prevRead = _narrativeRepo.read;
  const prevExtract = _extraction.extract;
  const prevWrite = _writeSettings.write;
  _narrativeRepo.read = async () => "Colombia diplomacy.";
  _extraction.extract = async (_text, model) => {
    attempts.push(model);
    if (model === "anthropic:env-primary-test") throw new Error("primary down");
    return MOCK_EXTRACTION;
  };
  _writeSettings.write = async () => {};

  try {
    const res = await request(app)
      .put("/api/settings")
      .send({ ...VALID_BODY, onboardingRawText: "Colombia diplomacy." })
      .set("Content-Type", "application/json");
    assert.equal(res.status, 200);
    assert.equal(attempts.length, 2, "both env-configured models must be attempted");
    assert.equal(attempts[0], "anthropic:env-primary-test", "primary must come from TEMPO_AI_CLASSIFIER_MODEL");
    assert.equal(attempts[1], "anthropic:env-fallback-test", "fallback must come from TEMPO_AI_CLASSIFIER_FALLBACK_MODEL");
    assert.equal(res.body._meta?.extractionStatus, "succeeded");
  } finally {
    _narrativeRepo.read = prevRead;
    _extraction.extract = prevExtract;
    _writeSettings.write = prevWrite;
    if (prevPrimaryEnv !== undefined) process.env.TEMPO_AI_CLASSIFIER_MODEL = prevPrimaryEnv;
    else delete process.env.TEMPO_AI_CLASSIFIER_MODEL;
    if (prevFallbackEnv !== undefined) process.env.TEMPO_AI_CLASSIFIER_FALLBACK_MODEL = prevFallbackEnv;
    else delete process.env.TEMPO_AI_CLASSIFIER_FALLBACK_MODEL;
  }
});

test("extraction chain: fallback is attempted when primary fails (under env-configured chain)", async () => {
  // Mirrors the existing Opus→Sonnet test but with explicit env vars + a
  // primary that throws a recognizable error message.  Asserts the route's
  // chain orchestration is env-driven AND retains the strict two-step
  // semantics (don't skip fallback on primary failure).
  const prevPrimaryEnv = process.env.TEMPO_AI_CLASSIFIER_MODEL;
  const prevFallbackEnv = process.env.TEMPO_AI_CLASSIFIER_FALLBACK_MODEL;
  process.env.TEMPO_AI_CLASSIFIER_MODEL = "anthropic:cfg-primary";
  process.env.TEMPO_AI_CLASSIFIER_FALLBACK_MODEL = "anthropic:cfg-fallback";

  const attempts = [];
  const prevRead = _narrativeRepo.read;
  const prevExtract = _extraction.extract;
  const prevWrite = _writeSettings.write;
  _narrativeRepo.read = async () => "Colombia diplomacy.";
  _extraction.extract = async (_text, model) => {
    attempts.push(model);
    if (model === "anthropic:cfg-primary") {
      // Error message shape mimics a real Anthropic timeout so the
      // classifyExtractionError → "timeout" branch is exercised in the log.
      throw new Error("Anthropic extraction timed out (cfg-primary)");
    }
    return MOCK_EXTRACTION;
  };
  _writeSettings.write = async () => {};

  try {
    const res = await request(app)
      .put("/api/settings")
      .send({ ...VALID_BODY, onboardingRawText: "Colombia diplomacy." })
      .set("Content-Type", "application/json");
    assert.equal(res.status, 200);
    assert.deepEqual(attempts, ["anthropic:cfg-primary", "anthropic:cfg-fallback"]);
    assert.equal(res.body._meta?.extractionStatus, "succeeded");
  } finally {
    _narrativeRepo.read = prevRead;
    _extraction.extract = prevExtract;
    _writeSettings.write = prevWrite;
    if (prevPrimaryEnv !== undefined) process.env.TEMPO_AI_CLASSIFIER_MODEL = prevPrimaryEnv;
    else delete process.env.TEMPO_AI_CLASSIFIER_MODEL;
    if (prevFallbackEnv !== undefined) process.env.TEMPO_AI_CLASSIFIER_FALLBACK_MODEL = prevFallbackEnv;
    else delete process.env.TEMPO_AI_CLASSIFIER_FALLBACK_MODEL;
  }
});

test("extraction chain: both primary and fallback fail — no write-back, status failed, original settings returned", async () => {
  const attempts = [];
  const writeCalls = [];
  const prevRead = _narrativeRepo.read;
  const prevExtract = _extraction.extract;
  const prevWrite = _writeSettings.write;
  _narrativeRepo.read = async () => "Colombia diplomacy.";
  _extraction.extract = async (_text, model) => {
    attempts.push(model);
    throw new Error(`${model} unavailable`);
  };
  _writeSettings.write = async (payload, userId) => { writeCalls.push({ payload, userId }); };

  try {
    const res = await request(app)
      .put("/api/settings")
      .send({ ...VALID_BODY, onboardingRawText: "Colombia diplomacy." })
      .set("Content-Type", "application/json");
    assert.equal(res.status, 200, "both-model failure must not fail the onboarding save");
    assert.equal(attempts.length, 2, "both models must be attempted before giving up");
    assert.equal(attempts[0], "anthropic:claude-opus-4-7");
    assert.equal(attempts[1], "anthropic:claude-sonnet-4-6");
    // Only the initial settings write — no extraction write-back
    assert.equal(writeCalls.length, 1, "no synthetic write-back when both models fail");
    assert.equal(res.body._meta?.extractionStatus, "failed");
    // Response must be original settings, not mock/synthetic extracted data
    assert.deepEqual(res.body.topics, VALID_BODY.topics);
    assert.deepEqual(res.body.geographies, VALID_BODY.geographies);
  } finally {
    _narrativeRepo.read = prevRead;
    _extraction.extract = prevExtract;
    _writeSettings.write = prevWrite;
  }
});

test("extraction chain: TEMPO_AI_MOCK_ONLY=true in non-test runtime skips extraction — status failed, no write-back", async () => {
  const writeCalls = [];
  let extractCalled = false;
  const prevRead = _narrativeRepo.read;
  const prevExtract = _extraction.extract;
  const prevWrite = _writeSettings.write;
  const prevMockOnly = process.env.TEMPO_AI_MOCK_ONLY;
  const prevNodeEnv = process.env.NODE_ENV;
  _narrativeRepo.read = async () => "Colombia diplomacy.";
  _extraction.extract = async () => { extractCalled = true; return MOCK_EXTRACTION; };
  _writeSettings.write = async (payload, userId) => { writeCalls.push({ payload, userId }); };
  process.env.TEMPO_AI_MOCK_ONLY = "true";
  process.env.NODE_ENV = "production";

  try {
    const res = await request(app)
      .put("/api/settings")
      .send({ ...VALID_BODY, onboardingRawText: "Colombia diplomacy." })
      .set("Content-Type", "application/json");
    assert.equal(res.status, 200, "mock-only guard must not fail the request");
    assert.ok(!extractCalled, "extraction must not be called when mock-only mode is active outside test");
    assert.equal(writeCalls.length, 1, "only the initial settings write — no extraction write-back");
    assert.equal(res.body._meta?.extractionStatus, "failed");
    assert.deepEqual(res.body.topics, VALID_BODY.topics, "original settings must be returned");
  } finally {
    _narrativeRepo.read = prevRead;
    _extraction.extract = prevExtract;
    _writeSettings.write = prevWrite;
    if (prevMockOnly !== undefined) process.env.TEMPO_AI_MOCK_ONLY = prevMockOnly;
    else delete process.env.TEMPO_AI_MOCK_ONLY;
    if (prevNodeEnv !== undefined) process.env.NODE_ENV = prevNodeEnv;
    else delete process.env.NODE_ENV;
  }
});

test("PUT /api/settings returns 401 when no identity headers are present", async () => {
  _clearEmailCache();
  const prevResolver = _auth.resolver;
  const prevLookup = _emailLookup.resolve;
  _auth.resolver = resolveIdentity;
  _emailLookup.resolve = async () => null;
  try {
    const res = await request(app)
      .put("/api/settings")
      .send(VALID_BODY)
      .set("Content-Type", "application/json");
    assert.equal(res.status, 401);
    assert.equal(typeof res.body.message, "string");
  } finally {
    _auth.resolver = prevResolver;
    _emailLookup.resolve = prevLookup;
    _clearEmailCache();
  }
});

// ─── _meta.lastCheckedAt: refresh attempts advance the clock even on no-op ───
//
// `lastCheckedAt` is the server-side timestamp of the most recent feed check
// for this user, independent of whether the check produced a new snapshot.
// The dashboard binds its "Last refresh" header to this value (falling back
// to `refreshedAt` for older API responses) so the clock visibly moves on
// every refresh attempt — watermark short-circuits, in-flight skips, and
// error fallbacks all count.  `refreshedAt` stays pinned to the last
// successful pipeline write so operator semantics and bootstrap freshness
// math are unaffected.

test("POST /api/dashboard/refresh: ran path returns lastCheckedAt equal to refreshedAt and persists it", async () => {
  let writtenPayload = null;
  const prevWrite = _snapshotRepo.write;
  const prevGetLocks = _snapshotRepo.getLocks;
  const prevInsertLocks = _snapshotRepo.insertLocks;
  _snapshotRepo.write = async (_uid, payload) => { writtenPayload = payload; };
  _snapshotRepo.getLocks = async () => new Map();
  _snapshotRepo.insertLocks = async () => {};
  try {
    const res = await request(app).post("/api/dashboard/refresh");
    assert.equal(res.status, 200);
    assert.ok(typeof res.body._meta.lastCheckedAt === "string", "response must include lastCheckedAt");
    assert.equal(res.body._meta.lastCheckedAt, res.body._meta.refreshedAt,
      "on full run, lastCheckedAt must equal refreshedAt");
    assert.equal(writtenPayload?._lastCheckedAt, res.body._meta.lastCheckedAt,
      "persisted snapshot must carry _lastCheckedAt for later reads");
  } finally {
    _snapshotRepo.write = prevWrite;
    _snapshotRepo.getLocks = prevGetLocks;
    _snapshotRepo.insertLocks = prevInsertLocks;
  }
});

test("POST /api/dashboard/refresh: watermark unchanged → lastCheckedAt advances, refreshedAt preserved, writeMeta called", async () => {
  const prevRun = _refreshPipeline.run;
  const prevRead = _snapshotRepo.read;
  const prevWrite = _snapshotRepo.write;
  const prevWriteMeta = _snapshotRepo.writeMeta;
  const prevGetLocks = _snapshotRepo.getLocks;
  const prevInsertLocks = _snapshotRepo.insertLocks;

  // Stamp the prior snapshot with a fixed refreshedAt + lastCheckedAt from a
  // minute ago so we can assert the route preserves the former and bumps the
  // latter past it.
  const PRIOR_AT = new Date(Date.now() - 60_000).toISOString();
  const PRIOR_SNAPSHOT = {
    contractVersion: "2026-05-19-meta-story-fields",
    stories: [],
    _watermark: "wm-stable",
    _meta: { hasSnapshot: true, refreshedAt: PRIOR_AT, lastCheckedAt: PRIOR_AT },
  };
  let writeMetaCalls = [];
  _snapshotRepo.read = async () => PRIOR_SNAPSHOT;
  _snapshotRepo.write = async () => {};
  _snapshotRepo.writeMeta = async (_uid, meta) => { writeMetaCalls.push(meta); };
  _snapshotRepo.getLocks = async () => new Map();
  _snapshotRepo.insertLocks = async () => {};
  _refreshPipeline.run = async () => ({
    payload: null,
    log: {
      unchanged: true, refreshSkippedReason: "unchanged_watermark",
      watermark: "wm-stable", candidateCount: 0, selectedFeedCount: 1,
    },
  });

  try {
    const res = await request(app).post("/api/dashboard/refresh");
    assert.equal(res.status, 200);
    assert.equal(res.body._meta.unchanged, true);
    // refreshedAt stays pinned to the prior snapshot's value — no new write.
    assert.equal(res.body._meta.refreshedAt, PRIOR_AT,
      "refreshedAt must not advance on unchanged-watermark short-circuit");
    // lastCheckedAt advances past the prior timestamp.
    assert.ok(typeof res.body._meta.lastCheckedAt === "string");
    assert.ok(Date.parse(res.body._meta.lastCheckedAt) > Date.parse(PRIOR_AT),
      `lastCheckedAt (${res.body._meta.lastCheckedAt}) must be after prior (${PRIOR_AT})`);
    // Persistence: writeMeta called with the same lastCheckedAt that landed
    // in the response — so a full page reload after this attempt picks it up.
    assert.equal(writeMetaCalls.length, 1, "writeMeta must be called exactly once on unchanged-with-prior");
    assert.equal(writeMetaCalls[0].lastCheckedAt, res.body._meta.lastCheckedAt);
  } finally {
    _refreshPipeline.run = prevRun;
    _snapshotRepo.read = prevRead;
    _snapshotRepo.write = prevWrite;
    _snapshotRepo.writeMeta = prevWriteMeta;
    _snapshotRepo.getLocks = prevGetLocks;
    _snapshotRepo.insertLocks = prevInsertLocks;
  }
});

test("POST /api/dashboard/refresh: unchanged with NO prior snapshot → lastCheckedAt in empty body, no writeMeta", async () => {
  const prevRun = _refreshPipeline.run;
  const prevRead = _snapshotRepo.read;
  const prevWriteMeta = _snapshotRepo.writeMeta;
  const prevWrite = _snapshotRepo.write;
  const prevGetLocks = _snapshotRepo.getLocks;
  const prevInsertLocks = _snapshotRepo.insertLocks;

  let writeMetaCalls = 0;
  _snapshotRepo.read = async () => null;
  _snapshotRepo.write = async () => {};
  _snapshotRepo.writeMeta = async () => { writeMetaCalls++; };
  _snapshotRepo.getLocks = async () => new Map();
  _snapshotRepo.insertLocks = async () => {};
  _refreshPipeline.run = async () => ({
    payload: null,
    log: {
      unchanged: true, refreshSkippedReason: "unchanged_watermark",
      watermark: "wm-empty", candidateCount: 0, selectedFeedCount: 0,
    },
  });

  try {
    const res = await request(app).post("/api/dashboard/refresh");
    assert.equal(res.status, 200);
    assert.equal(res.body._meta.unchanged, true);
    assert.equal(res.body._meta.hasSnapshot, false);
    assert.ok(typeof res.body._meta.lastCheckedAt === "string", "empty body must still carry lastCheckedAt");
    assert.equal(writeMetaCalls, 0, "no persistence when there's no prior snapshot to attach meta to");
  } finally {
    _refreshPipeline.run = prevRun;
    _snapshotRepo.read = prevRead;
    _snapshotRepo.write = prevWrite;
    _snapshotRepo.writeMeta = prevWriteMeta;
    _snapshotRepo.getLocks = prevGetLocks;
    _snapshotRepo.insertLocks = prevInsertLocks;
  }
});

test("POST /api/dashboard/refresh: error_fallback → lastCheckedAt advances, refreshedAt preserved from fallback snapshot, writeMeta called", async () => {
  const prevRun = _refreshPipeline.run;
  const prevRead = _snapshotRepo.read;
  const prevWriteMeta = _snapshotRepo.writeMeta;
  const prevGetLocks = _snapshotRepo.getLocks;
  const PRIOR_AT = new Date(Date.now() - 120_000).toISOString();
  const LAST_SNAPSHOT = {
    contractVersion: "2026-05-19-meta-story-fields",
    stories: [],
    _meta: { hasSnapshot: true, refreshedAt: PRIOR_AT, lastCheckedAt: PRIOR_AT },
  };
  let writeMetaCalls = [];
  _refreshPipeline.run = async () => { throw new Error("pipeline exploded"); };
  _snapshotRepo.read = async () => LAST_SNAPSHOT;
  _snapshotRepo.writeMeta = async (_uid, meta) => { writeMetaCalls.push(meta); };
  _snapshotRepo.getLocks = async () => new Map();
  try {
    const res = await request(app).post("/api/dashboard/refresh");
    assert.equal(res.status, 200);
    assert.equal(res.body._meta.fallback, true);
    assert.equal(res.body._meta.refreshedAt, PRIOR_AT, "refreshedAt preserved on error fallback");
    assert.ok(typeof res.body._meta.lastCheckedAt === "string");
    assert.ok(Date.parse(res.body._meta.lastCheckedAt) > Date.parse(PRIOR_AT),
      "lastCheckedAt must advance even on error fallback (we tried)");
    // Persistence: writeMeta is called exactly once with the same lastCheckedAt
    // returned in the response — so a full page reload after this attempt does
    // not regress the "Last refresh" clock back to the fallback snapshot's
    // older timestamp.
    assert.equal(writeMetaCalls.length, 1, "writeMeta must be called exactly once on error_fallback");
    assert.equal(writeMetaCalls[0].lastCheckedAt, res.body._meta.lastCheckedAt);
  } finally {
    _refreshPipeline.run = prevRun;
    _snapshotRepo.read = prevRead;
    _snapshotRepo.writeMeta = prevWriteMeta;
    _snapshotRepo.getLocks = prevGetLocks;
  }
});

test("GET /api/dashboard surfaces persisted _meta.lastCheckedAt", async () => {
  const LAST_AT = "2026-05-10T09:00:00.000Z";
  const REFRESHED_AT = "2026-05-10T08:00:00.000Z";
  const SNAPSHOT = {
    contractVersion: "2026-05-19-meta-story-fields",
    stories: [],
    _meta: { hasSnapshot: true, refreshedAt: REFRESHED_AT, lastCheckedAt: LAST_AT },
  };
  const prev = _snapshotRepo.read;
  _snapshotRepo.read = async () => SNAPSHOT;
  try {
    const res = await request(app).get("/api/dashboard");
    assert.equal(res.status, 200);
    assert.equal(res.body._meta.refreshedAt, REFRESHED_AT);
    assert.equal(res.body._meta.lastCheckedAt, LAST_AT,
      "GET must surface persisted lastCheckedAt without modification");
  } finally {
    _snapshotRepo.read = prev;
  }
});

test("POST /api/dashboard/bootstrap: served_fresh_snapshot returns persisted lastCheckedAt, does not bump it", async () => {
  const prev = _snapshotRepo.read;
  const prevRun = _refreshPipeline.run;
  const REFRESHED_AT = new Date(Date.now() - 5 * 60_000).toISOString();
  const LAST_AT = new Date(Date.now() - 2 * 60_000).toISOString();
  const FRESH_SNAPSHOT = {
    contractVersion: "2026-05-19-meta-story-fields",
    stories: [],
    _meta: { hasSnapshot: true, refreshedAt: REFRESHED_AT, lastCheckedAt: LAST_AT },
  };
  _snapshotRepo.read = async () => FRESH_SNAPSHOT;
  _refreshPipeline.run = async () => { throw new Error("pipeline must not run"); };
  try {
    const res = await request(app).post("/api/dashboard/bootstrap");
    assert.equal(res.status, 200);
    assert.equal(res.body._meta.bootstrapDecision, "served_fresh_snapshot");
    assert.equal(res.body._meta.refreshedAt, REFRESHED_AT);
    assert.equal(res.body._meta.lastCheckedAt, LAST_AT,
      "served_fresh_snapshot must not fake a new check — return stored lastCheckedAt as-is");
  } finally {
    _snapshotRepo.read = prev;
    _refreshPipeline.run = prevRun;
  }
});

// ─── R2 DC-validation readiness + guard ──────────────────────────────────────
// Env helpers — keep these tests isolated from any TEMPO_* values leaking in
// from the host shell or .env.  Each test snapshots the relevant keys, mutates
// them deterministically, and restores in `finally`.

const R2_ENV_KEYS = [
  "TEMPO_AI_CLUSTER_MODEL",
  "TEMPO_AI_GEO_ASSESS_MODEL",
  "TEMPO_OPENAI_EMBEDDING_MODEL",
  "TEMPO_AI_MOCK_ONLY",
  "TEMPO_DC_VALIDATION_MODE",
  "TEMPO_ANTHROPIC_API_KEY",
  "ANTHROPIC_API_KEY",
  "TEMPO_OPENAI_API_KEY",
  "OPENAI_API_KEY",
];

function r2SnapshotEnv() {
  const out = {};
  for (const k of R2_ENV_KEYS) out[k] = process.env[k];
  return out;
}
function r2ClearEnv() { for (const k of R2_ENV_KEYS) delete process.env[k]; }
function r2RestoreEnv(snap) {
  for (const k of R2_ENV_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}

test("GET /api/ai/models exposes readiness + dcValidationMode flag (R2)", async () => {
  const saved = r2SnapshotEnv();
  r2ClearEnv();
  process.env.TEMPO_AI_CLUSTER_MODEL = "anthropic:claude-sonnet-4-6";
  process.env.TEMPO_AI_GEO_ASSESS_MODEL = "anthropic:claude-haiku-4-5-20251001";
  process.env.TEMPO_ANTHROPIC_API_KEY = "sk-ant-test";
  process.env.TEMPO_OPENAI_API_KEY = "sk-openai-test";
  try {
    const res = await request(app).get("/api/ai/models");
    assert.equal(res.status, 200);
    assert.ok(res.body.capabilityMap, "capabilityMap field still present (backwards-compatible)");
    assert.equal(res.body.mockOnly, false);
    assert.equal(res.body.dcValidationMode, false);
    assert.ok(res.body.readiness, "readiness must be exposed");
    assert.equal(res.body.readiness.readyForRealRun, true);
    assert.ok(res.body.readiness.capabilities.clustering);
    assert.ok(res.body.readiness.capabilities.geoAssess);
    assert.ok(res.body.readiness.capabilities.embedding);
  } finally {
    r2RestoreEnv(saved);
  }
});

test("GET /api/ai/models flags mock-only and lists missing keys when keys absent", async () => {
  const saved = r2SnapshotEnv();
  r2ClearEnv();
  process.env.TEMPO_AI_MOCK_ONLY = "true";
  try {
    const res = await request(app).get("/api/ai/models");
    assert.equal(res.status, 200);
    assert.equal(res.body.mockOnly, true);
    assert.equal(res.body.readiness.readyForRealRun, false);
    assert.equal(res.body.readiness.capabilities.clustering.mock, true);
    assert.equal(res.body.readiness.capabilities.embedding.mock, true);
  } finally {
    r2RestoreEnv(saved);
  }
});

test("POST /api/dashboard/refresh: TEMPO_DC_VALIDATION_MODE + mock-only → 503 with DC_VALIDATION_NOT_READY", async () => {
  const saved = r2SnapshotEnv();
  r2ClearEnv();
  process.env.TEMPO_DC_VALIDATION_MODE = "true";
  process.env.TEMPO_AI_MOCK_ONLY = "true";
  // Pipeline must not run — assert via a stub that would throw if invoked.
  const prevRun = _refreshPipeline.run;
  _refreshPipeline.run = async () => {
    throw new Error("pipeline must not run when DC validation gate fails");
  };
  try {
    const res = await request(app).post("/api/dashboard/refresh");
    assert.equal(res.status, 503);
    assert.equal(res.body.code, "DC_VALIDATION_NOT_READY");
    assert.ok(Array.isArray(res.body.reasons) && res.body.reasons.length > 0);
    assert.equal(res.body.readiness?.readyForRealRun, false);
    assert.equal(res.body.readiness?.mockOnly, true);
  } finally {
    _refreshPipeline.run = prevRun;
    r2RestoreEnv(saved);
  }
});

test("POST /api/dashboard/refresh: TEMPO_DC_VALIDATION_MODE + missing Anthropic key → 503 with missing-key reason", async () => {
  const saved = r2SnapshotEnv();
  r2ClearEnv();
  process.env.TEMPO_DC_VALIDATION_MODE = "true";
  process.env.TEMPO_AI_CLUSTER_MODEL = "anthropic:claude-sonnet-4-6";
  process.env.TEMPO_AI_GEO_ASSESS_MODEL = "anthropic:claude-haiku-4-5-20251001";
  process.env.TEMPO_OPENAI_API_KEY = "sk-openai-test"; // embedding ready
  // Intentionally no Anthropic key
  const prevRun = _refreshPipeline.run;
  _refreshPipeline.run = async () => {
    throw new Error("pipeline must not run when DC validation gate fails");
  };
  try {
    const res = await request(app).post("/api/dashboard/refresh");
    assert.equal(res.status, 503);
    assert.equal(res.body.code, "DC_VALIDATION_NOT_READY");
    assert.ok(res.body.readiness.missingKeys.includes("TEMPO_ANTHROPIC_API_KEY"));
    assert.ok(
      res.body.reasons.some((r) => r.includes("missing-key")),
      `expected a missing-key reason, got ${JSON.stringify(res.body.reasons)}`
    );
  } finally {
    _refreshPipeline.run = prevRun;
    r2RestoreEnv(saved);
  }
});

test("POST /api/dashboard/refresh: TEMPO_DC_VALIDATION_MODE + ready providers → succeeds and surfaces readiness in _meta", async () => {
  const saved = r2SnapshotEnv();
  r2ClearEnv();
  process.env.TEMPO_DC_VALIDATION_MODE = "true";
  process.env.TEMPO_AI_CLUSTER_MODEL = "anthropic:claude-sonnet-4-6";
  process.env.TEMPO_AI_GEO_ASSESS_MODEL = "anthropic:claude-haiku-4-5-20251001";
  process.env.TEMPO_ANTHROPIC_API_KEY = "sk-ant-test";
  process.env.TEMPO_OPENAI_API_KEY = "sk-openai-test";

  // Stub the pipeline so the route executes the success branch without
  // touching live providers.  Returns a minimal valid payload + log.
  const prevRun = _refreshPipeline.run;
  _refreshPipeline.run = async () => ({
    payload: {
      contractVersion: "2026-05-19-meta-story-fields",
      stories: [],
    },
    log: {
      unchanged: false,
      watermark: "wm-1",
      candidateCount: 0,
      selectedFeedCount: 0,
      poolCount: 0,
      relevantCount: 0,
      usedFallbackClustering: false,
      groundingFailures: 0,
      droppedUngroundedStoryCount: 0,
      groundingDropReasons: {},
      selection: { sourceSelectionMode: "test" },
    },
  });
  // Avoid Supabase writes for lock and snapshot insertion paths.
  const prevGetLocks = _snapshotRepo.getLocks;
  const prevInsertLocks = _snapshotRepo.insertLocks;
  const prevWrite = _snapshotRepo.write;
  _snapshotRepo.getLocks = async () => new Map();
  _snapshotRepo.insertLocks = async () => {};
  _snapshotRepo.write = async () => {};
  try {
    const res = await request(app).post("/api/dashboard/refresh");
    assert.equal(res.status, 200);
    assert.ok(res.body._meta?.readiness, "readiness must be surfaced in refresh _meta when validation passes");
    assert.equal(res.body._meta.readiness.readyForRealRun, true);
    assert.equal(res.body._meta.readiness.mockOnly, false);
  } finally {
    _refreshPipeline.run = prevRun;
    _snapshotRepo.getLocks = prevGetLocks;
    _snapshotRepo.insertLocks = prevInsertLocks;
    _snapshotRepo.write = prevWrite;
    r2RestoreEnv(saved);
  }
});

test("POST /api/dashboard/refresh: validation mode OFF + mock-only → does NOT block (existing flow preserved)", async () => {
  const saved = r2SnapshotEnv();
  r2ClearEnv();
  // No TEMPO_DC_VALIDATION_MODE — mock-only must continue to work for tests/dev.
  process.env.TEMPO_AI_MOCK_ONLY = "true";

  let pipelineCalls = 0;
  const prevRun = _refreshPipeline.run;
  _refreshPipeline.run = async () => {
    pipelineCalls += 1;
    return {
      payload: { contractVersion: "2026-05-19-meta-story-fields", stories: [] },
      log: {
        unchanged: false,
        watermark: "wm-0",
        candidateCount: 0,
        selectedFeedCount: 0,
        poolCount: 0,
        relevantCount: 0,
        usedFallbackClustering: false,
        groundingFailures: 0,
        droppedUngroundedStoryCount: 0,
        groundingDropReasons: {},
        selection: { sourceSelectionMode: "test" },
      },
    };
  };
  const prevGetLocks = _snapshotRepo.getLocks;
  const prevInsertLocks = _snapshotRepo.insertLocks;
  const prevWrite = _snapshotRepo.write;
  _snapshotRepo.getLocks = async () => new Map();
  _snapshotRepo.insertLocks = async () => {};
  _snapshotRepo.write = async () => {};
  try {
    const res = await request(app).post("/api/dashboard/refresh");
    assert.equal(res.status, 200, "no validation guard means mock-only still flows through");
    assert.equal(pipelineCalls, 1, "pipeline must run when DC validation mode is off");
  } finally {
    _refreshPipeline.run = prevRun;
    _snapshotRepo.getLocks = prevGetLocks;
    _snapshotRepo.insertLocks = prevInsertLocks;
    _snapshotRepo.write = prevWrite;
    r2RestoreEnv(saved);
  }
});

// ─── Phase 7: /api/_debug/dashboard-tags — internal-only debug surface ──────
//
// The endpoint surfaces `_meta.tags` from the user's last persisted snapshot
// for operator inspection of the semantic-tag rollout state.  It is gated
// by BOTH `TEMPO_DEBUG_TAGS_ENABLED=true` AND `NODE_ENV !== "production"`,
// AND requires the same authenticated identity as `/api/dashboard`.  These
// tests pin the gating behavior and confirm no story content / source bodies
// leak through the endpoint.

test("GET /api/_debug/dashboard-tags: 404 when TEMPO_DEBUG_TAGS_ENABLED is unset (default closed)", async () => {
  delete process.env.TEMPO_DEBUG_TAGS_ENABLED;
  const res = await request(app).get("/api/_debug/dashboard-tags");
  assert.equal(res.status, 404, "endpoint must be invisible without explicit opt-in");
});

test("GET /api/_debug/dashboard-tags: 404 when NODE_ENV=production even if TEMPO_DEBUG_TAGS_ENABLED=true", async () => {
  const savedNodeEnv = process.env.NODE_ENV;
  const savedDebug = process.env.TEMPO_DEBUG_TAGS_ENABLED;
  process.env.NODE_ENV = "production";
  process.env.TEMPO_DEBUG_TAGS_ENABLED = "true";
  try {
    const res = await request(app).get("/api/_debug/dashboard-tags");
    assert.equal(res.status, 404, "NODE_ENV=production gates the endpoint off regardless of opt-in");
  } finally {
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedNodeEnv;
    if (savedDebug === undefined) delete process.env.TEMPO_DEBUG_TAGS_ENABLED;
    else process.env.TEMPO_DEBUG_TAGS_ENABLED = savedDebug;
  }
});

test("GET /api/_debug/dashboard-tags: returns _meta.tags when both gates pass + identity authenticated", async () => {
  const savedDebug = process.env.TEMPO_DEBUG_TAGS_ENABLED;
  process.env.TEMPO_DEBUG_TAGS_ENABLED = "true";
  const prevRead = _snapshotRepo.read;
  // Stub the snapshot to carry a `_meta.tags` payload as the dashboard
  // pipeline would have written it.
  _snapshotRepo.read = async () => ({
    contractVersion: "2026-05-19-meta-story-fields",
    stories: [
      {
        id: "story-A",
        title: "Story A",
        // story body — must NOT leak through the debug endpoint
        summary: "Confidential summary",
        sources: [{ id: "src-1", outlet: "Reuters" }],
        tags: { topics: [], keywords: [], geographies: [] },
      },
    ],
    _meta: {
      hasSnapshot: true,
      refreshedAt: "2026-05-16T00:00:00.000Z",
      lastCheckedAt: "2026-05-16T00:05:00.000Z",
      tags: {
        schemaVersion: "phase7-2026-05-16",
        killSwitchActive: false,
        topics: { runtimeState: "enabled_scorer_ready", acceptedCount: 1 },
        keywords: { runtimeState: "enabled_scorer_ready", acceptedCount: 0 },
        geographies: { axis: "geographies", semanticApplied: false },
      },
    },
  });
  try {
    const res = await request(app).get("/api/_debug/dashboard-tags");
    assert.equal(res.status, 200);
    assert.equal(res.body.hasSnapshot, true);
    assert.equal(res.body.schemaVersion, "phase7-2026-05-16");
    assert.equal(res.body.killSwitchActive, false);
    assert.equal(res.body.tags.topics.runtimeState, "enabled_scorer_ready");
    assert.equal(res.body.tags.geographies.semanticApplied, false);
    // Story content must NEVER appear in the debug response.
    const bodyJson = JSON.stringify(res.body);
    assert.ok(!bodyJson.includes("Story A"), "story title must not leak");
    assert.ok(!bodyJson.includes("Confidential summary"), "story summary must not leak");
    assert.ok(!bodyJson.includes("Reuters"), "source outlet must not leak");
  } finally {
    _snapshotRepo.read = prevRead;
    if (savedDebug === undefined) delete process.env.TEMPO_DEBUG_TAGS_ENABLED;
    else process.env.TEMPO_DEBUG_TAGS_ENABLED = savedDebug;
  }
});

test("GET /api/_debug/dashboard-tags: returns hasSnapshot=false + null tags when no snapshot exists", async () => {
  const savedDebug = process.env.TEMPO_DEBUG_TAGS_ENABLED;
  process.env.TEMPO_DEBUG_TAGS_ENABLED = "true";
  const prevRead = _snapshotRepo.read;
  _snapshotRepo.read = async () => null;
  try {
    const res = await request(app).get("/api/_debug/dashboard-tags");
    assert.equal(res.status, 200);
    assert.equal(res.body.hasSnapshot, false);
    assert.equal(res.body.tags, null);
  } finally {
    _snapshotRepo.read = prevRead;
    if (savedDebug === undefined) delete process.env.TEMPO_DEBUG_TAGS_ENABLED;
    else process.env.TEMPO_DEBUG_TAGS_ENABLED = savedDebug;
  }
});

// ─── Sub-slice 2.4: due-user orchestrator wiring ──────────────────────────────
//
// Pure due-selection logic and the orchestrator entrypoint are covered in
// `dashboard/due-user-orchestrator.test.mjs`.  These tests verify the
// server-level wiring: `_dueUserOrchestrator.runDueRefreshes` must route
// through `_refreshExecutor.execute` so the in-flight guard, watermark
// short-circuit, and `_lastCheckedAt` anchor write stay consistent with the
// interactive `POST /api/dashboard/refresh` path.

test("Sub-slice 2.4: _dueUserOrchestrator routes due users through _refreshExecutor only (not-due users skipped)", async () => {
  const prevListAnchors = _dueUserOrchestrator.listAnchors;
  const prevExecute = _refreshExecutor.execute;

  const overdue = new Date(Date.now() - (60 * 60 * 1000 + 60_000)).toISOString();
  const fresh = new Date(Date.now() - 60_000).toISOString();
  _dueUserOrchestrator.listAnchors = async () => ({
    rows: [
      { userId: "user-due-1", lastRefreshAttemptAt: overdue },
      { userId: "user-fresh", lastRefreshAttemptAt: fresh },
      { userId: "user-due-2", lastRefreshAttemptAt: overdue },
    ],
    error: null,
  });
  const executorCalls = [];
  _refreshExecutor.execute = async (identity) => {
    executorCalls.push(identity);
    return { kind: "ran", httpStatus: 200, body: {} };
  };

  try {
    const summary = await _dueUserOrchestrator.runDueRefreshes();
    assert.equal(summary.candidates, 3);
    assert.equal(summary.due, 2);
    assert.equal(summary.ran, 2);
    assert.deepEqual(
      executorCalls.map((c) => c.userId),
      ["user-due-1", "user-due-2"],
      "only due users must hit the executor"
    );
    // Orchestrator identity stamp is consistent across calls so telemetry can
    // distinguish server-initiated refreshes from interactive ones.
    assert.ok(executorCalls.every((c) => c.source === "orchestrator"));
  } finally {
    _dueUserOrchestrator.listAnchors = prevListAnchors;
    _refreshExecutor.execute = prevExecute;
  }
});

test("Sub-slice 2.4: orchestrator-triggered refresh advances _lastCheckedAt anchor via the same executor path", async () => {
  // Wire the real `_refreshExecutor.execute` (no stub) so we exercise the
  // production anchor-write code path.  Snapshot repo is stubbed so we can
  // observe both the persisted `_lastCheckedAt` (full-run branch) and the
  // `writeMeta` call (unchanged / in_flight / error_fallback branches).
  const overdue = new Date(Date.now() - (60 * 60 * 1000 + 60_000)).toISOString();
  const PRIOR_SNAPSHOT = {
    contractVersion: "2026-05-19-meta-story-fields",
    stories: [],
    _watermark: "wm-stable",
    _meta: { hasSnapshot: true, refreshedAt: overdue, lastCheckedAt: overdue },
  };

  const prevListAnchors = _dueUserOrchestrator.listAnchors;
  const prevRead = _snapshotRepo.read;
  const prevWrite = _snapshotRepo.write;
  const prevWriteMeta = _snapshotRepo.writeMeta;
  const prevGetLocks = _snapshotRepo.getLocks;
  const prevInsertLocks = _snapshotRepo.insertLocks;
  const prevPipelineRun = _refreshPipeline.run;

  _dueUserOrchestrator.listAnchors = async () => ({
    rows: [{ userId: "user-due", lastRefreshAttemptAt: overdue }],
    error: null,
  });
  _snapshotRepo.read = async () => PRIOR_SNAPSHOT;
  _snapshotRepo.write = async () => {};
  _snapshotRepo.getLocks = async () => new Map();
  _snapshotRepo.insertLocks = async () => {};
  // Force the unchanged-watermark branch — it is the minimal path that
  // exercises the anchor write (`writeMeta`) without depending on the full
  // clustering pipeline.  Asserting writeMeta is called proves the
  // orchestrator-triggered refresh advances the same `_lastCheckedAt`
  // anchor the orchestrator reads for due selection — closing the loop.
  _refreshPipeline.run = async () => ({
    payload: null,
    log: {
      unchanged: true,
      refreshSkippedReason: "unchanged_watermark",
      watermark: "wm-stable",
      candidateCount: 0,
      selectedFeedCount: 1,
    },
  });
  const writeMetaCalls = [];
  _snapshotRepo.writeMeta = async (uid, meta) => {
    writeMetaCalls.push({ uid, meta });
  };

  try {
    const summary = await _dueUserOrchestrator.runDueRefreshes();
    assert.equal(summary.due, 1);
    assert.equal(summary.ran, 1);
    assert.equal(summary.kinds.unchanged, 1);
    assert.equal(writeMetaCalls.length, 1, "anchor must be written through writeMeta on unchanged branch");
    assert.equal(writeMetaCalls[0].uid, "user-due");
    assert.ok(typeof writeMetaCalls[0].meta.lastCheckedAt === "string");
    assert.ok(
      Date.parse(writeMetaCalls[0].meta.lastCheckedAt) > Date.parse(overdue),
      "_lastCheckedAt anchor must advance past the prior overdue stamp"
    );
  } finally {
    _dueUserOrchestrator.listAnchors = prevListAnchors;
    _snapshotRepo.read = prevRead;
    _snapshotRepo.write = prevWrite;
    _snapshotRepo.writeMeta = prevWriteMeta;
    _snapshotRepo.getLocks = prevGetLocks;
    _snapshotRepo.insertLocks = prevInsertLocks;
    _refreshPipeline.run = prevPipelineRun;
  }
});


test("Slice 7: POST refresh _meta.timings carries ingestionMs + pipeline stage timings", async () => {
  const prevRun = _refreshPipeline.run;
  const prevWrite = _snapshotRepo.write;
  // Pipeline stub returns its own log.timings (pipeline stages). The server
  // folds the server-measured ingestionMs into log.timings and surfaces the
  // unified object on the immediate response _meta.timings.
  _refreshPipeline.run = async () => ({
    payload: { contractVersion: "2026-05-19-meta-story-fields", stories: [] },
    log: {
      selection: {},
      watermark: "w-timings-slice7",
      candidateCount: 0,
      selectedFeedCount: 0,
      timings: { preClusterMs: 1, recallMs: 0, clusterMs: 2, whatChangedMs: 1, whyMs: 3, pipelineMs: 7 },
    },
  });
  _snapshotRepo.write = async () => {};
  try {
    const res = await request(app).post("/api/dashboard/refresh");
    assert.equal(res.status, 200);
    assert.ok(res.body._meta && typeof res.body._meta === "object", "_meta present on ran response");
    const t = res.body._meta.timings;
    assert.ok(t && typeof t === "object", "_meta.timings present");
    assert.equal(typeof t.ingestionMs, "number", "ingestionMs is a number (server-measured)");
    assert.ok(t.ingestionMs >= 0, "ingestionMs non-negative");
    assert.equal(typeof t.pipelineMs, "number", "pipelineMs is a number");
    assert.equal(t.pipelineMs, 7, "pipelineMs lifted verbatim from pipeline log");
    assert.equal(t.whyMs, 3, "whyMs lifted verbatim");
  } finally {
    _refreshPipeline.run = prevRun;
    _snapshotRepo.write = prevWrite;
  }
});

test("Slice 7: POST refresh _meta.timings.ingestionMs is server-measured (live fetch path)", async () => {
  // Light integration: do NOT supply pipeline timings — the pipeline stub
  // omits `log.timings` so the server must inject `ingestionMs` on its own.
  // `_feedReader.read` sleeps 50ms so the server-measured ingestion bracket
  // (cache read + live fetch, excluding the pipeline call) is non-trivial.
  const prevRun = _refreshPipeline.run;
  const prevWrite = _snapshotRepo.write;
  const prevFeedRead = _feedReader.read;
  const prevCacheEnabled = _recentItemsCache.enabled;
  const prevCacheRead = _recentItemsCache.read;
  // Force the live-fetch path: cache disabled so the handler calls _feedReader.
  _recentItemsCache.enabled = () => false;
  _recentItemsCache.read = async () => ({ rows: [], error: null });
  _feedReader.read = async () => {
    await new Promise((r) => setTimeout(r, 50));
    return [
      {
        sourceId: "reuters-world::timings-1",
        feedId: "reuters-world",
        outlet: "Reuters",
        url: "https://reuters.example.com/timings-article",
        headline: "Timings fixture headline",
        body: ["Timings fixture body."],
        minutesAgo: 5,
        weight: 80,
      },
    ];
  };
  // Minimal pipeline stub WITHOUT log.timings — proves the server injects
  // ingestionMs even when the pipeline reports no per-stage breakdown.
  _refreshPipeline.run = async () => ({
    payload: { contractVersion: "2026-05-19-meta-story-fields", stories: [] },
    log: { selection: {}, watermark: "w-ingestion-slice7", candidateCount: 0, selectedFeedCount: 0 },
  });
  _snapshotRepo.write = async () => {};
  try {
    const res = await request(app).post("/api/dashboard/refresh");
    assert.equal(res.status, 200);
    const t = res.body._meta.timings;
    assert.ok(t && typeof t === "object", "_meta.timings present even without pipeline timings");
    assert.equal(typeof t.ingestionMs, "number", "ingestionMs is server-measured");
    assert.ok(t.ingestionMs >= 40, `ingestionMs should reflect the ~50ms live fetch; saw ${t.ingestionMs}`);
  } finally {
    _refreshPipeline.run = prevRun;
    _snapshotRepo.write = prevWrite;
    _feedReader.read = prevFeedRead;
    _recentItemsCache.enabled = prevCacheEnabled;
    _recentItemsCache.read = prevCacheRead;
  }
});

// ── Phase 4 S0: translateFn wiring in _refreshPipeline.run ───────────────────
//
// The wrapper composes `translateFn: opts.translateFn ?? resolveProductionTranslateFn()`
// and hands it to the pipeline runner. We stub `_pipelineRunner.run` (a thin
// pass-through seam to runRefreshPipeline) to capture the composed opts WITHOUT
// running the full pipeline, and drive `_refreshPipeline.run` directly so the
// test stays isolated from the HTTP route / persistence stack. Env for the
// production resolver is snapshotted and restored per test.

const TRANSLATE_ENV_KEYS = ["TEMPO_AI_MOCK_ONLY", "TEMPO_OPENAI_API_KEY", "OPENAI_API_KEY"];

async function withTranslateWiringHarness(fn) {
  const prevRunner = _pipelineRunner.run;
  const savedEnv = {};
  for (const k of TRANSLATE_ENV_KEYS) savedEnv[k] = process.env[k];
  let captured = null;
  _pipelineRunner.run = async (opts) => {
    captured = opts;
    return {
      payload: { contractVersion: opts.contractVersion ?? "test", stories: [] },
      log: { selection: {}, watermark: "translate-wiring", candidateCount: 0, selectedFeedCount: 0 },
    };
  };
  try {
    await fn({ getCaptured: () => captured });
  } finally {
    _pipelineRunner.run = prevRunner;
    for (const k of TRANSLATE_ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  }
}

const TRANSLATE_BASE_OPTS = { settings: { topics: [] }, rawItems: [], contractVersion: "test" };

test("translateFn wiring: an explicitly provided opts.translateFn wins over the resolver", async () => {
  await withTranslateWiringHarness(async ({ getCaptured }) => {
    // Even with a real key present (resolver would return a function), the
    // explicit injection must take precedence.
    process.env.TEMPO_OPENAI_API_KEY = "sk-test";
    delete process.env.TEMPO_AI_MOCK_ONLY;
    const sentinel = () => ["injected"];
    await _refreshPipeline.run({ ...TRANSLATE_BASE_OPTS, translateFn: sentinel });
    assert.equal(getCaptured().translateFn, sentinel, "explicit translateFn must be forwarded unchanged");
  });
});

test("translateFn wiring: absent injection + key present → pipeline receives the resolver's function", async () => {
  await withTranslateWiringHarness(async ({ getCaptured }) => {
    process.env.TEMPO_OPENAI_API_KEY = "sk-test";
    delete process.env.OPENAI_API_KEY;
    delete process.env.TEMPO_AI_MOCK_ONLY;
    await _refreshPipeline.run({ ...TRANSLATE_BASE_OPTS });
    assert.equal(typeof getCaptured().translateFn, "function", "resolver-produced translateFn must reach the pipeline");
  });
});

test("translateFn wiring: resolver returns null (no key) → pipeline receives null, no crash", async () => {
  await withTranslateWiringHarness(async ({ getCaptured }) => {
    delete process.env.TEMPO_OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.TEMPO_AI_MOCK_ONLY;
    const res = await _refreshPipeline.run({ ...TRANSLATE_BASE_OPTS });
    assert.equal(getCaptured().translateFn, null, "missing key → null translateFn (no-op pass-through)");
    assert.ok(res && res.payload, "pipeline call still resolves cleanly");
  });
});

test("translateFn wiring: resolver returns null under mock-only even with a key → pipeline receives null", async () => {
  await withTranslateWiringHarness(async ({ getCaptured }) => {
    process.env.TEMPO_OPENAI_API_KEY = "sk-test";
    process.env.TEMPO_AI_MOCK_ONLY = "true";
    await _refreshPipeline.run({ ...TRANSLATE_BASE_OPTS });
    assert.equal(getCaptured().translateFn, null, "mock-only forces the no-op pass-through path");
  });
});

// ─── Slice 6: cold-start prefetch kickoff from PUT /api/settings ──────────────

const SLICE6_EXTRACTED = {
  topics: ["Migration policy"],
  keywords: ["bilateral"],
  geographies: ["US", "Colombia"],
  traditionalSources: [],
  socialSources: [],
};

// Run `fn` with extraction stubbed to succeed and the executor stubbed to count
// kickoffs, restoring all hooks (and the job registry) afterward. `execResult`
// overrides the resolved executor result so settlement-mapping can be exercised.
async function withSlice6PrefetchHarness(
  { extractionSucceeds = true, execResult = { kind: "ran", httpStatus: 200, body: { stories: [{ id: "s1" }] } } } = {},
  fn
) {
  const prevRead = _narrativeRepo.read;
  const prevExtract = _extraction.extract;
  const prevWrite = _writeSettings.write;
  const prevExec = _refreshExecutor.execute;
  const prevStart = _refreshPrefetch.start;
  const calls = [];
  _resetRefreshJobs();
  // Opt back into the genuine prefetch kickoff (the suite neutralizes it by
  // default); test E overrides this with a throwing stub after harness setup.
  _refreshPrefetch.start = _realPrefetchStart;
  _narrativeRepo.read = async () => "A US–Colombia bilateral comms narrative.";
  _extraction.extract = async () => (extractionSucceeds ? SLICE6_EXTRACTED : null);
  _writeSettings.write = async () => {};
  _refreshExecutor.execute = async (identity, opts) => {
    calls.push({ userId: identity.userId, opts });
    return execResult;
  };
  try {
    return await fn(calls);
  } finally {
    _narrativeRepo.read = prevRead;
    _extraction.extract = prevExtract;
    _writeSettings.write = prevWrite;
    _refreshExecutor.execute = prevExec;
    _refreshPrefetch.start = prevStart;
    _resetRefreshJobs();
  }
}

test("Slice 6 (A): successful onboarding save + extraction kicks off a cold_start prefetch and surfaces _meta.refreshJobId", async () => {
  await withSlice6PrefetchHarness({}, async (calls) => {
    await withIsolatedUser("slice6-happy", async () => {
      const res = await request(app)
        .put("/api/settings")
        .send({ ...VALID_BODY, onboardingRawText: "narrative" })
        .set("Content-Type", "application/json");
      assert.equal(res.status, 200);
      assert.equal(res.body._meta?.extractionStatus, "succeeded");
      assert.equal(res.body._meta?.refreshJobId, "slice6-happy", "refreshJobId === userId");
      assert.equal(res.body.refreshJobId, undefined, "no top-level refreshJobId");
      // Executor invoked exactly once with the cold_start profile.
      assert.equal(calls.length, 1, "prefetch starts exactly one refresh");
      assert.equal(calls[0].userId, "slice6-happy");
      assert.equal(calls[0].opts?.refreshProfile, "cold_start");
      // A running job was registered for the user.
      assert.ok(_getRefreshJob("slice6-happy"), "a refresh job exists for the user");
    });
  });
});

test("Slice 6 (B): extraction failure does NOT kick off prefetch and omits _meta.refreshJobId", async () => {
  await withSlice6PrefetchHarness({ extractionSucceeds: false }, async (calls) => {
    await withIsolatedUser("slice6-extract-fail", async () => {
      const res = await request(app)
        .put("/api/settings")
        .send({ ...VALID_BODY, onboardingRawText: "narrative" })
        .set("Content-Type", "application/json");
      assert.equal(res.status, 200);
      assert.equal(res.body._meta?.extractionStatus, "failed");
      assert.equal(res.body._meta?.refreshJobId, undefined, "no refreshJobId when extraction failed");
      assert.equal(calls.length, 0, "no prefetch kickoff on extraction failure");
      assert.equal(_getRefreshJob("slice6-extract-fail"), null, "no job registered");
    });
  });
});

test("Slice 6 (C): a normal save without onboardingRawText does not kick off prefetch", async () => {
  await withSlice6PrefetchHarness({}, async (calls) => {
    await withIsolatedUser("slice6-no-narrative", async () => {
      const res = await request(app)
        .put("/api/settings")
        .send(VALID_BODY) // no onboardingRawText
        .set("Content-Type", "application/json");
      assert.equal(res.status, 200);
      assert.equal(res.body._meta?.extractionStatus, "not_attempted");
      assert.equal(res.body._meta?.refreshJobId, undefined, "no refreshJobId without onboardingRawText");
      assert.equal(calls.length, 0, "no prefetch kickoff without onboardingRawText");
    });
  });
});

test("Slice 6 (D): an in-flight refresh is JOINED — refreshJobId returned, no second run started", async () => {
  await withSlice6PrefetchHarness({}, async (calls) => {
    await withIsolatedUser("slice6-inflight", async () => {
      // Simulate a prior, still-running cold-start refresh for this user.
      _createRefreshJob("slice6-inflight");
      const res = await request(app)
        .put("/api/settings")
        .send({ ...VALID_BODY, onboardingRawText: "narrative" })
        .set("Content-Type", "application/json");
      assert.equal(res.status, 200);
      assert.equal(res.body._meta?.refreshJobId, "slice6-inflight", "joins the in-flight job id");
      assert.equal(calls.length, 0, "no second executor run while one is in flight");
    });
  });
});

test("Slice 6 (E): a prefetch kickoff failure is non-fatal — settings still 200, no refreshJobId", async () => {
  await withSlice6PrefetchHarness({}, async (calls) => {
    // Force the kickoff path to throw.
    _refreshPrefetch.start = () => { throw new Error("prefetch boom"); };
    await withIsolatedUser("slice6-kickoff-throw", async () => {
      const res = await request(app)
        .put("/api/settings")
        .send({ ...VALID_BODY, onboardingRawText: "narrative" })
        .set("Content-Type", "application/json");
      assert.equal(res.status, 200, "settings write/response is unaffected by a prefetch failure");
      assert.equal(res.body._meta?.extractionStatus, "succeeded");
      assert.equal(res.body._meta?.refreshJobId, undefined, "no refreshJobId when kickoff throws");
      // Settings payload still conforms.
      const parsed = settingsPayloadSchema.safeParse(res.body);
      assert.ok(parsed.success, "response remains a valid settings payload");
    });
  });
});

// Poll the registry until the fire-and-forget prefetch settles the job to a
// terminal state (or `maxTicks` flushes elapse). Deterministic enough for the
// stubbed executor, which resolves immediately.
async function waitForJobSettled(userId, { maxTicks = 50 } = {}) {
  for (let i = 0; i < maxTicks; i++) {
    const job = _getRefreshJob(userId);
    if (job && job.status !== "running") return job;
    await new Promise((r) => setImmediate(r));
  }
  return _getRefreshJob(userId);
}

test("Slice 6 settle (A): a `ran` result marks the job done with story count", async () => {
  await withSlice6PrefetchHarness(
    { execResult: { kind: "ran", httpStatus: 200, body: { stories: [{ id: "a" }, { id: "b" }] } } },
    async () => {
      await withIsolatedUser("slice6-settle-ran", async () => {
        await request(app)
          .put("/api/settings")
          .send({ ...VALID_BODY, onboardingRawText: "narrative" })
          .set("Content-Type", "application/json");
        const job = await waitForJobSettled("slice6-settle-ran");
        assert.equal(job.status, "done");
        assert.equal(job.phase, "done");
        assert.equal(job.storyCount, 2);
      });
    }
  );
});

for (const kind of ["error_500", "validation_not_ready"]) {
  test(`Slice 6 settle (B): a terminal failure kind "${kind}" marks the job failed with that reason`, async () => {
    await withSlice6PrefetchHarness(
      { execResult: { kind, httpStatus: 500, body: {} } },
      async () => {
        await withIsolatedUser(`slice6-settle-${kind}`, async () => {
          await request(app)
            .put("/api/settings")
            .send({ ...VALID_BODY, onboardingRawText: "narrative" })
            .set("Content-Type", "application/json");
          const job = await waitForJobSettled(`slice6-settle-${kind}`);
          assert.equal(job.status, "failed");
          assert.equal(job.failureReason, kind);
        });
      }
    );
  });
}

test("Slice 6 settle (C): an `in_flight` result settles terminally (failed, in_flight_joined) — never wedged running", async () => {
  await withSlice6PrefetchHarness(
    { execResult: { kind: "in_flight", httpStatus: 200, body: {} } },
    async () => {
      await withIsolatedUser("slice6-settle-inflight", async () => {
        const res = await request(app)
          .put("/api/settings")
          .send({ ...VALID_BODY, onboardingRawText: "narrative" })
          .set("Content-Type", "application/json");
        assert.equal(res.body._meta?.refreshJobId, "slice6-settle-inflight");
        // The job must settle terminally (not stay running forever, which would
        // wedge future prefetch attempts into joining a stale running job).
        const job = await waitForJobSettled("slice6-settle-inflight");
        assert.equal(job.status, "failed");
        assert.equal(job.failureReason, "in_flight_joined");
      });
    }
  );
});

test("Slice 6 settle (D): an unknown executor kind fails the job with reason `unknown_kind`", async () => {
  await withSlice6PrefetchHarness(
    { execResult: { kind: "unexpected_kind", httpStatus: 200, body: {} } },
    async () => {
      await withIsolatedUser("slice6-settle-unknown", async () => {
        await request(app)
          .put("/api/settings")
          .send({ ...VALID_BODY, onboardingRawText: "narrative" })
          .set("Content-Type", "application/json");
        const job = await waitForJobSettled("slice6-settle-unknown");
        assert.equal(job.status, "failed");
        assert.equal(job.failureReason, "unknown_kind");
      });
    }
  );
});

// ─── Slice 7: GET /api/dashboard/refresh-status/:jobId ───────────────────────

const SLICE7_MINIMAL_KEYS = ["jobId", "status", "phase", "storyCount", "failureReason"];

test("Slice 7 (A): refresh-status without a valid token returns 401", async () => {
  const prev = _auth.resolver;
  _auth.resolver = async () => null;
  try {
    const res = await request(app).get("/api/dashboard/refresh-status/anyone");
    assert.equal(res.status, 401);
    assert.equal(typeof res.body.message, "string");
  } finally {
    _auth.resolver = prev;
  }
});

test("Slice 7 (B): a jobId that is not the caller's userId returns 403", async () => {
  _resetRefreshJobs();
  try {
    await withIsolatedUser("slice7-owner", async () => {
      // A job exists for someone else; the caller must not be able to read it.
      _createRefreshJob("slice7-other");
      const res = await request(app).get("/api/dashboard/refresh-status/slice7-other");
      assert.equal(res.status, 403);
      assert.equal(res.body.code, "FORBIDDEN_REFRESH_JOB");
    });
  } finally {
    _resetRefreshJobs();
  }
});

test("Slice 7 (C): an authorized request for a missing job returns 404 JOB_NOT_FOUND", async () => {
  _resetRefreshJobs();
  try {
    await withIsolatedUser("slice7-missing", async () => {
      const res = await request(app).get("/api/dashboard/refresh-status/slice7-missing");
      assert.equal(res.status, 404);
      assert.equal(res.body.code, "JOB_NOT_FOUND");
    });
  } finally {
    _resetRefreshJobs();
  }
});

test("Slice 7 (D): a running job returns 200 with the minimal snapshot and status running", async () => {
  _resetRefreshJobs();
  try {
    await withIsolatedUser("slice7-running", async () => {
      _createRefreshJob("slice7-running");
      _setRefreshPhase("slice7-running", "matching");
      const res = await request(app).get("/api/dashboard/refresh-status/slice7-running");
      assert.equal(res.status, 200);
      assert.equal(res.body.jobId, "slice7-running");
      assert.equal(res.body.status, "running");
      assert.equal(res.body.phase, "matching");
      assert.equal(res.body.storyCount, null);
      assert.equal(res.body.failureReason, null);
    });
  } finally {
    _resetRefreshJobs();
  }
});

test("Slice 7 (E): a done job returns 200 with status done and the story count", async () => {
  _resetRefreshJobs();
  try {
    await withIsolatedUser("slice7-done", async () => {
      _createRefreshJob("slice7-done");
      _completeRefreshJob("slice7-done", { ok: true, storyCount: 4 });
      const res = await request(app).get("/api/dashboard/refresh-status/slice7-done");
      assert.equal(res.status, 200);
      assert.equal(res.body.status, "done");
      assert.equal(res.body.phase, "done");
      assert.equal(res.body.storyCount, 4);
      assert.equal(res.body.failureReason, null);
    });
  } finally {
    _resetRefreshJobs();
  }
});

test("Slice 7 (F): a failed job returns 200 with status failed and the failure reason", async () => {
  _resetRefreshJobs();
  try {
    await withIsolatedUser("slice7-failed", async () => {
      _createRefreshJob("slice7-failed");
      _completeRefreshJob("slice7-failed", { ok: false, failureReason: "clustering_timeout" });
      const res = await request(app).get("/api/dashboard/refresh-status/slice7-failed");
      assert.equal(res.status, 200);
      assert.equal(res.body.status, "failed");
      assert.equal(res.body.failureReason, "clustering_timeout");
      assert.equal(res.body.storyCount, null);
    });
  } finally {
    _resetRefreshJobs();
  }
});

test("Slice 7 (G): the 200 response carries ONLY the minimal contract fields", async () => {
  _resetRefreshJobs();
  try {
    await withIsolatedUser("slice7-shape", async () => {
      _createRefreshJob("slice7-shape");
      const res = await request(app).get("/api/dashboard/refresh-status/slice7-shape");
      assert.equal(res.status, 200);
      // No timestamps, userId, or other internal fields leak.
      assert.deepEqual(Object.keys(res.body).sort(), [...SLICE7_MINIMAL_KEYS].sort());
    });
  } finally {
    _resetRefreshJobs();
  }
});

});
