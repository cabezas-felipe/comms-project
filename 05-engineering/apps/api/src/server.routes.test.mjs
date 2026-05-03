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
// Seed source-feeds fixture for GET /api/ingestion/sources.
const FIXTURE_SOURCE_FEEDS = { feeds: [{ id: "nyt-politics", name: "The New York Times", kind: "rss", url: "https://example.com/rss", weight: 95, active: true }] };
await writeFile(path.join(tmpDir, "source-feeds.json"), JSON.stringify(FIXTURE_SOURCE_FEEDS), "utf8");

const { app, _auth, _extraction, _emailLookup, _clearEmailCache, resolveIdentity, _sourceRegistrySync, _feedManifest } = await import("./server.mjs");
const { default: request } = await import("supertest");
const { settingsPayloadSchema, dashboardPayloadSchema } = await import("@tempo/contracts");

// Inject a deterministic test identity so protected routes authenticate without a live Supabase instance.
const TEST_USER_ID = "test-user-id";
_auth.resolver = async () => ({ userId: TEST_USER_ID, source: "bearer" });

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

test("GET /api/dashboard returns schema-conformant payload with ranked stories", async () => {
  const res = await request(app).get("/api/dashboard");
  assert.equal(res.status, 200);
  assert.equal(res.body.contractVersion, "2026-04-22-slice1");
  assert.ok(Array.isArray(res.body.stories), "stories must be an array");
  assert.equal(res.body.stories.length, 1);
  const parsed = dashboardPayloadSchema.safeParse(res.body);
  assert.ok(parsed.success, `response must conform to dashboardPayloadSchema: ${JSON.stringify(parsed.error?.errors)}`);
  assert.ok(!("aiSummaryMeta" in res.body.stories[0]), "aiSummaryMeta must be stripped from response");
});

test("GET /api/ingestion/sources returns declared feed configuration (JSON fallback, no Supabase)", async () => {
  // SUPABASE_URL is not set in the test env — route must fall back to source-feeds.json.
  const res = await request(app).get("/api/ingestion/sources");
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.feeds), "feeds must be an array");
  assert.equal(res.body.feeds.length, 1);
  assert.equal(res.body.feeds[0].id, "nyt-politics");
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

// ─── Onboarding extraction — fallback logic ───────────────────────────────────

const MOCK_EXTRACTION = { topics: ["test-topic"], keywords: [], geographies: ["US"], sources: [] };

test("POST /api/onboarding/extract returns 200 when primary succeeds", async () => {
  const saved = _extraction.extract;
  _extraction.extract = async () => MOCK_EXTRACTION;
  try {
    const res = await request(app)
      .post("/api/onboarding/extract")
      .send({ text: "some onboarding text" })
      .set("Content-Type", "application/json");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.topics, MOCK_EXTRACTION.topics);
  } finally {
    _extraction.extract = saved;
  }
});

test("POST /api/onboarding/extract returns 200 when primary fails but fallback succeeds", async () => {
  const savedExtract = _extraction.extract;
  const savedPrimary = process.env.TEMPO_AI_CLASSIFIER_MODEL;
  const savedFallback = process.env.TEMPO_AI_CLASSIFIER_FALLBACK_MODEL;
  process.env.TEMPO_AI_CLASSIFIER_MODEL = "mock-anthropic-haiku";
  process.env.TEMPO_AI_CLASSIFIER_FALLBACK_MODEL = "mock-openai-mini";
  let callCount = 0;
  _extraction.extract = async (_text, model) => {
    callCount++;
    if (model === "mock-anthropic-haiku") throw new Error("primary unavailable");
    return MOCK_EXTRACTION;
  };
  try {
    const res = await request(app)
      .post("/api/onboarding/extract")
      .send({ text: "some onboarding text" })
      .set("Content-Type", "application/json");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.topics, MOCK_EXTRACTION.topics);
    assert.equal(callCount, 2, "should have called extract twice (primary + fallback)");
  } finally {
    _extraction.extract = savedExtract;
    if (savedPrimary !== undefined) process.env.TEMPO_AI_CLASSIFIER_MODEL = savedPrimary;
    else delete process.env.TEMPO_AI_CLASSIFIER_MODEL;
    if (savedFallback !== undefined) process.env.TEMPO_AI_CLASSIFIER_FALLBACK_MODEL = savedFallback;
    else delete process.env.TEMPO_AI_CLASSIFIER_FALLBACK_MODEL;
  }
});

test("POST /api/onboarding/extract returns 500 when both primary and fallback fail", async () => {
  const savedExtract = _extraction.extract;
  const savedPrimary = process.env.TEMPO_AI_CLASSIFIER_MODEL;
  const savedFallback = process.env.TEMPO_AI_CLASSIFIER_FALLBACK_MODEL;
  process.env.TEMPO_AI_CLASSIFIER_MODEL = "mock-anthropic-haiku";
  process.env.TEMPO_AI_CLASSIFIER_FALLBACK_MODEL = "mock-openai-mini";
  _extraction.extract = async () => { throw new Error("all models down"); };
  try {
    const res = await request(app)
      .post("/api/onboarding/extract")
      .send({ text: "some onboarding text" })
      .set("Content-Type", "application/json");
    assert.equal(res.status, 500);
    assert.ok(typeof res.body.message === "string");
  } finally {
    _extraction.extract = savedExtract;
    if (savedPrimary !== undefined) process.env.TEMPO_AI_CLASSIFIER_MODEL = savedPrimary;
    else delete process.env.TEMPO_AI_CLASSIFIER_MODEL;
    if (savedFallback !== undefined) process.env.TEMPO_AI_CLASSIFIER_FALLBACK_MODEL = savedFallback;
    else delete process.env.TEMPO_AI_CLASSIFIER_FALLBACK_MODEL;
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
