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

const { app, _auth, _extraction, _emailLookup, _clearEmailCache, resolveIdentity, _sourceRegistrySync, _feedManifest, _narrativeRepo, _writeSettings, _atomicSave, _readSettings } = await import("./server.mjs");
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

// ─── Topic taxonomy backward compatibility ─────────────────────────────────────
// These tests verify that normalizeTopicLabel is applied on both sides of the
// dashboard filter so legacy item labels ("Security cooperation") match settings
// that were written back in normalized form ("Security policy"), and vice-versa.

test("dashboard filter: normalized settings topic matches item with legacy topic label", async () => {
  // Items carry the old-form label that pre-dates normalization.
  const oldLabelItems = [{ ...FIXTURE_SOURCE_ITEMS[0], topic: "Security cooperation", clusterId: "test-old-label" }];
  await writeFile(path.join(tmpDir, "source-items.json"), JSON.stringify(oldLabelItems), "utf8");

  // Settings hold the post-normalization form (what extraction write-back produces).
  await request(app).put("/api/settings")
    .send({ ...VALID_BODY, topics: ["Security policy"] })
    .set("Content-Type", "application/json");

  const res = await request(app).get("/api/dashboard");
  assert.equal(res.status, 200);
  assert.ok(res.body.stories.length > 0,
    "item labeled 'Security cooperation' must match normalized setting 'Security policy'");

  // Restore fixture and settings for subsequent tests.
  await writeFile(path.join(tmpDir, "source-items.json"), JSON.stringify(FIXTURE_SOURCE_ITEMS), "utf8");
  await request(app).put("/api/settings").send(VALID_BODY).set("Content-Type", "application/json");
});

test("dashboard filter: old settings topic still matches item with the same old label (backward compat)", async () => {
  // Neither side was ever normalized — both use the old form.
  const oldLabelItems = [{ ...FIXTURE_SOURCE_ITEMS[0], topic: "Security cooperation", clusterId: "test-old-both" }];
  await writeFile(path.join(tmpDir, "source-items.json"), JSON.stringify(oldLabelItems), "utf8");

  await request(app).put("/api/settings")
    .send({ ...VALID_BODY, topics: ["Security cooperation"] })
    .set("Content-Type", "application/json");

  const res = await request(app).get("/api/dashboard");
  assert.equal(res.status, 200);
  assert.ok(res.body.stories.length > 0,
    "old-form setting 'Security cooperation' must still match item with same old label");

  await writeFile(path.join(tmpDir, "source-items.json"), JSON.stringify(FIXTURE_SOURCE_ITEMS), "utf8");
  await request(app).put("/api/settings").send(VALID_BODY).set("Content-Type", "application/json");
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

const MOCK_EXTRACTION = { topics: ["test-topic"], keywords: [], geographies: ["US"], traditionalSources: [], socialSources: [] };

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
