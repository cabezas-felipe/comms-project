import { after, test } from "node:test";
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

const { app, _auth, _extraction, _emailLookup, _clearEmailCache, resolveIdentity, _sourceRegistrySync, _feedManifest, _narrativeRepo, _writeSettings, _atomicSave, _readSettings, _snapshotRepo, _refreshPipeline, _refreshExecutor, _embeddings } = await import("./server.mjs");
const { default: request } = await import("supertest");
const { settingsPayloadSchema, dashboardPayloadSchema } = await import("@tempo/contracts");

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
  contractVersion: "2026-04-22-slice1",
  topics: ["Diplomatic relations"],
  keywords: ["OFAC"],
  geographies: ["US"],
  traditionalSources: ["Reuters"],
  socialSources: ["@latamwatcher"],
};

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
  // First save — establish baseline
  const first = { ...VALID_BODY, traditionalSources: ["Reuters"], socialSources: [] };
  await request(app).put("/api/settings").send(first).set("Content-Type", "application/json");

  // Second save — capture what sync sees
  const second = { ...VALID_BODY, traditionalSources: ["Reuters", "NYT"], socialSources: [] };
  let captured = null;
  const prev = _sourceRegistrySync.record;
  _sourceRegistrySync.record = async (args) => { captured = args; };
  try {
    const res = await request(app)
      .put("/api/settings")
      .send(second)
      .set("Content-Type", "application/json");
    assert.equal(res.status, 200);
    assert.ok(captured !== null, "registry sync must have been called");
    // previousPayload reflects the first save's sources
    assert.deepEqual(captured.previousPayload?.traditionalSources, ["Reuters"]);
    // nextPayload is the second save
    assert.deepEqual(captured.nextPayload.traditionalSources, ["Reuters", "NYT"]);
  } finally {
    _sourceRegistrySync.record = prev;
  }
});

test("GET /api/dashboard returns empty stories with hasSnapshot=false when no snapshot exists", async () => {
  // Override snapshot repo to simulate no snapshot on record.
  const prev = _snapshotRepo.read;
  _snapshotRepo.read = async () => null;
  try {
    const res = await request(app).get("/api/dashboard");
    assert.equal(res.status, 200);
    assert.equal(res.body.contractVersion, "2026-04-22-slice1");
    assert.ok(Array.isArray(res.body.stories));
    assert.equal(res.body.stories.length, 0);
    assert.equal(res.body._meta?.hasSnapshot, false);
  } finally {
    _snapshotRepo.read = prev;
  }
});

test("GET /api/dashboard returns persisted snapshot when one exists", async () => {
  const SNAPSHOT = {
    contractVersion: "2026-04-22-slice1",
    stories: [
      {
        id: "snap-story-1",
        metaStoryId: "snap-story-1",
        title: "Snapshot Story",
        subtitle: "A subtitle.",
        geographies: ["US"],
        topic: "Diplomatic relations",
        takeaway: "Takeaway",
        summary: "Summary.",
        whyItMatters: "Why.",
        whatChanged: "Latest update 30 min ago.",
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
    assert.equal(res.body.contractVersion, "2026-04-22-slice1");
    assert.equal(res.body.stories.length, 1);
    assert.equal(res.body.stories[0].id, "snap-story-1");
    const parsed = dashboardPayloadSchema.safeParse(res.body);
    assert.ok(parsed.success, `response must conform to dashboardPayloadSchema: ${JSON.stringify(parsed.error?.errors)}`);
  } finally {
    _snapshotRepo.read = prev;
  }
});

// ─── Topic taxonomy backward compatibility ─────────────────────────────────────
// These tests verify that normalizeTopicLabel is applied during relevance filtering
// so legacy item labels ("Security cooperation") match settings written in normalized
// form ("Security policy"), and vice-versa.  These now exercise POST /api/dashboard/refresh
// since that is where filtering runs.

test("refresh pipeline: normalized settings topic matches item with legacy topic label", async () => {
  const oldLabelItems = [{ ...FIXTURE_SOURCE_ITEMS[0], topic: "Security cooperation", clusterId: "test-old-label" }];
  await writeFile(path.join(tmpDir, "source-items.json"), JSON.stringify(oldLabelItems), "utf8");

  await request(app).put("/api/settings")
    .send({ ...VALID_BODY, topics: ["Security policy"] })
    .set("Content-Type", "application/json");

  // Inject snapshot write capture to verify stories were produced.
  let capturedPayload = null;
  const prevWrite = _snapshotRepo.write;
  _snapshotRepo.write = async (_uid, payload) => { capturedPayload = payload; };
  const prevGetLocks = _snapshotRepo.getLocks;
  _snapshotRepo.getLocks = async () => new Map();
  const prevInsertLocks = _snapshotRepo.insertLocks;
  _snapshotRepo.insertLocks = async () => {};
  try {
    const res = await request(app).post("/api/dashboard/refresh");
    assert.equal(res.status, 200);
    assert.ok(capturedPayload !== null);
    assert.ok(capturedPayload.stories.length > 0,
      "item labeled 'Security cooperation' must match normalized setting 'Security policy'");
  } finally {
    _snapshotRepo.write = prevWrite;
    _snapshotRepo.getLocks = prevGetLocks;
    _snapshotRepo.insertLocks = prevInsertLocks;
    await writeFile(path.join(tmpDir, "source-items.json"), JSON.stringify(FIXTURE_SOURCE_ITEMS), "utf8");
    await request(app).put("/api/settings").send(VALID_BODY).set("Content-Type", "application/json");
  }
});

test("refresh pipeline: old settings topic still matches item with the same old label (backward compat)", async () => {
  const oldLabelItems = [{ ...FIXTURE_SOURCE_ITEMS[0], topic: "Security cooperation", clusterId: "test-old-both" }];
  await writeFile(path.join(tmpDir, "source-items.json"), JSON.stringify(oldLabelItems), "utf8");

  await request(app).put("/api/settings")
    .send({ ...VALID_BODY, topics: ["Security cooperation"] })
    .set("Content-Type", "application/json");

  let capturedPayload = null;
  const prevWrite = _snapshotRepo.write;
  _snapshotRepo.write = async (_uid, payload) => { capturedPayload = payload; };
  const prevGetLocks = _snapshotRepo.getLocks;
  _snapshotRepo.getLocks = async () => new Map();
  const prevInsertLocks = _snapshotRepo.insertLocks;
  _snapshotRepo.insertLocks = async () => {};
  try {
    const res = await request(app).post("/api/dashboard/refresh");
    assert.equal(res.status, 200);
    assert.ok(capturedPayload !== null);
    assert.ok(capturedPayload.stories.length > 0,
      "old-form setting 'Security cooperation' must still match item with same old label");
  } finally {
    _snapshotRepo.write = prevWrite;
    _snapshotRepo.getLocks = prevGetLocks;
    _snapshotRepo.insertLocks = prevInsertLocks;
    await writeFile(path.join(tmpDir, "source-items.json"), JSON.stringify(FIXTURE_SOURCE_ITEMS), "utf8");
    await request(app).put("/api/settings").send(VALID_BODY).set("Content-Type", "application/json");
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
    contractVersion: "2026-04-22-slice1",
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
  // VALID_BODY (used in setup) sets traditionalSources=["Reuters"], socialSources=["@latamwatcher"].
  // Reuters resolves; @latamwatcher matches social row but social has no implemented connector.
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
  }
});

test("GET /api/dashboard surfaces persisted _selectionMeta as _meta.selection", async () => {
  const SNAPSHOT = {
    contractVersion: "2026-04-22-slice1",
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
    contractVersion: "2026-04-22-slice1",
    stories: [{
      id: MS_ID, metaStoryId: MS_ID, title, subtitle: "Sub.",
      geographies: ["US"], topic: "Diplomatic relations",
      takeaway: "T", summary: "S", whyItMatters: "W", whatChanged: "C",
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
    for (const l of newLocks) locks.set(l.metaStoryId, { title: l.title, subtitle: l.subtitle });
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

test("POST /api/dashboard/refresh: on failure, returns last good snapshot with fallback=true", async () => {
  const LAST_SNAPSHOT = {
    contractVersion: "2026-04-22-slice1",
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
    contractVersion: "2026-04-22-slice1",
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
    contractVersion: "2026-04-22-slice1",
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
    contractVersion: "2026-04-22-slice1",
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
    contractVersion: "2026-04-22-slice1",
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
    contractVersion: "2026-04-22-slice1",
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
    contractVersion: "2026-04-22-slice1",
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
      payload: { contractVersion: "2026-04-22-slice1", stories: [] },
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
    contractVersion: "2026-04-22-slice1",
    stories: [
      { id: "s1", metaStoryId: "s1", title: "T1", subtitle: "Sub.", geographies: ["US"], topic: "Diplomatic relations", takeaway: "T", summary: "S", whyItMatters: "W", whatChanged: "C", priority: "standard", outletCount: 1, tags: { topics: [], keywords: [], geographies: [] }, sources: [] },
      { id: "s2", metaStoryId: "s2", title: "T2", subtitle: "Sub.", geographies: ["US"], topic: "Diplomatic relations", takeaway: "T", summary: "S", whyItMatters: "W", whatChanged: "C", priority: "standard", outletCount: 1, tags: { topics: [], keywords: [], geographies: [] }, sources: [] },
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
    contractVersion: "2026-04-22-slice1",
    stories: [],
    _watermark: "old-wm",
  });
  _snapshotRepo.write = async () => {};
  _snapshotRepo.getLocks = async () => new Map();
  _snapshotRepo.insertLocks = async () => {};
  _refreshPipeline.run = async (opts) => {
    priorWatermarkSeen = opts.priorWatermark;
    return {
      payload: { contractVersion: "2026-04-22-slice1", stories: [] },
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
      payload: { contractVersion: "2026-04-22-slice1", stories: [] },
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
      payload: { contractVersion: "2026-04-22-slice1", stories: [] },
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
    contractVersion: "2026-04-22-slice1",
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
    contractVersion: "2026-04-22-slice1",
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
      payload: { contractVersion: "2026-04-22-slice1", stories: [] },
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
    payload: { contractVersion: "2026-04-22-slice1", stories: [] },
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
    contractVersion: "2026-04-22-slice1",
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
    contractVersion: "2026-04-22-slice1",
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
      payload: { contractVersion: "2026-04-22-slice1", stories: [] },
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
    contractVersion: "2026-04-22-slice1",
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
        contractVersion: "2026-04-22-slice1",
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
    contractVersion: "2026-04-22-slice1",
    stories: [],
    _meta: { hasSnapshot: true, refreshedAt: new Date(Date.now() - 90 * 60_000).toISOString() },
  });
  _refreshExecutor.execute = async () => ({
    kind: "in_flight",
    httpStatus: 200,
    body: {
      contractVersion: "2026-04-22-slice1",
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
    contractVersion: "2026-04-22-slice1",
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
  _atomicSave.execute = async (args) => { capturedArgs = args; };
  _writeSettings.write = async () => { settingsWriteCalled = true; };
  _narrativeRepo.append = async () => { narrativeAppendCalled = true; };
  // Prevent post-save extraction from hitting the fake Supabase URL.
  _narrativeRepo.read = async () => null;
  // Prevent the previous-settings read from hitting the fake Supabase URL.
  _readSettings.has = async () => false;

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
      contractVersion: "2026-04-22-slice1",
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
    contractVersion: "2026-04-22-slice1",
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
    contractVersion: "2026-04-22-slice1",
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
    contractVersion: "2026-04-22-slice1",
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
    contractVersion: "2026-04-22-slice1",
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
      contractVersion: "2026-04-22-slice1",
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
      payload: { contractVersion: "2026-04-22-slice1", stories: [] },
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
