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

const { app, _auth, _extraction } = await import("./server.mjs");
const { default: request } = await import("supertest");
const { settingsPayloadSchema, dashboardPayloadSchema } = await import("@tempo/contracts");

// Inject a deterministic test user so protected routes authenticate without a live Supabase instance.
const TEST_USER_ID = "test-user-id";
_auth.resolver = async () => TEST_USER_ID;

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

test("GET /api/ingestion/sources returns declared feed configuration", async () => {
  const res = await request(app).get("/api/ingestion/sources");
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.feeds), "feeds must be an array");
  assert.equal(res.body.feeds.length, 1);
  assert.equal(res.body.feeds[0].id, "nyt-politics");
  assert.equal(typeof res.body.feeds[0].kind, "string");
  assert.equal(typeof res.body.feeds[0].weight, "number");
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
