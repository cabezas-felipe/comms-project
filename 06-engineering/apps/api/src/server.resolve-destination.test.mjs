import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Isolated data dir; no Supabase env so env-check tests start from a clean slate.
const tmpDir = await mkdtemp(path.join(tmpdir(), "tempo-resolve-dest-test-"));
process.env.TEMPO_DATA_DIR = tmpDir;
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.SUPABASE_ANON_KEY;

const { app, _resolveDestination } = await import("./server.mjs");
const { default: request } = await import("supertest");
const { DEFAULT_SETTINGS } = await import("./db/settings-repo.mjs");

after(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function withSupabase(url, key, fn) {
  const prevUrl = process.env.SUPABASE_URL;
  const prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (url === undefined) delete process.env.SUPABASE_URL;
  else process.env.SUPABASE_URL = url;
  if (key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  else process.env.SUPABASE_SERVICE_ROLE_KEY = key;
  return fn().finally(() => {
    if (prevUrl !== undefined) process.env.SUPABASE_URL = prevUrl;
    else delete process.env.SUPABASE_URL;
    if (prevKey !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = prevKey;
    else delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });
}

const KNOWN_USER = { id: "user-abc-123", email: "known@example.com" };

const EMPTY_SETTINGS = {
  ...DEFAULT_SETTINGS,
  topics: [],
  keywords: [],
  geographies: [],
  socialSources: [],
  traditionalSources: [],
};

// ─── Input validation ─────────────────────────────────────────────────────────

test("POST /api/auth/resolve-destination returns 400 when email is missing", async () => {
  const res = await request(app)
    .post("/api/auth/resolve-destination")
    .send({})
    .set("Content-Type", "application/json");
  assert.equal(res.status, 400);
  assert.ok(res.body.message.toLowerCase().includes("email"));
});

test("POST /api/auth/resolve-destination returns 400 when email has no @", async () => {
  const res = await request(app)
    .post("/api/auth/resolve-destination")
    .send({ email: "notvalid" })
    .set("Content-Type", "application/json");
  assert.equal(res.status, 400);
  assert.ok(res.body.message.toLowerCase().includes("email"));
});

// ─── Missing Supabase config ──────────────────────────────────────────────────

test("POST /api/auth/resolve-destination returns 503 when Supabase env is unset", async () => {
  // SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are deleted at module top.
  const res = await request(app)
    .post("/api/auth/resolve-destination")
    .send({ email: "user@example.com" })
    .set("Content-Type", "application/json");
  assert.equal(res.status, 503);
  assert.ok(
    res.body.message.includes("SUPABASE_URL") || res.body.message.includes("SUPABASE_SERVICE_ROLE_KEY"),
    `expected 503 mentioning env vars, got: ${res.body.message}`
  );
});

// ─── Success paths — hooks injected to avoid live Supabase ────────────────────
// _resolveDestination.findUserByEmail and .readSettingsForUser are both mocked
// so neither real Supabase nor real filesystem is exercised in these tests.

test("POST /api/auth/resolve-destination returns 403 for unknown email with no destination", () =>
  withSupabase("https://example.supabase.co", "fake-key", async () => {
    const origFind = _resolveDestination.findUserByEmail;
    _resolveDestination.findUserByEmail = async () => null;
    try {
      const res = await request(app)
        .post("/api/auth/resolve-destination")
        .send({ email: "ghost@example.com" })
        .set("Content-Type", "application/json");
      assert.equal(res.status, 403);
      assert.equal(res.body.allowed, false);
      assert.equal(typeof res.body.message, "string");
      assert.ok(res.body.message.length > 0, "message must be non-empty");
      // Critically: no destination field — frontend must not navigate
      assert.equal(res.body.destination, undefined);
    } finally {
      _resolveDestination.findUserByEmail = origFind;
    }
  }));

test("POST /api/auth/resolve-destination returns /onboarding for known user with no onboarding entries", () =>
  withSupabase("https://example.supabase.co", "fake-key", async () => {
    const origFind = _resolveDestination.findUserByEmail;
    const origRead = _resolveDestination.readSettingsForUser;
    _resolveDestination.findUserByEmail = async () => KNOWN_USER;
    _resolveDestination.readSettingsForUser = async () => EMPTY_SETTINGS;
    try {
      const res = await request(app)
        .post("/api/auth/resolve-destination")
        .send({ email: KNOWN_USER.email })
        .set("Content-Type", "application/json");
      assert.equal(res.status, 200);
      assert.equal(res.body.destination, "/onboarding");
      assert.deepEqual(res.body.user, { id: KNOWN_USER.id, email: KNOWN_USER.email });
    } finally {
      _resolveDestination.findUserByEmail = origFind;
      _resolveDestination.readSettingsForUser = origRead;
    }
  }));

test("POST /api/auth/resolve-destination returns /dashboard for known user with onboarding entries", () =>
  withSupabase("https://example.supabase.co", "fake-key", async () => {
    const origFind = _resolveDestination.findUserByEmail;
    const origRead = _resolveDestination.readSettingsForUser;
    _resolveDestination.findUserByEmail = async () => KNOWN_USER;
    _resolveDestination.readSettingsForUser = async () => ({
      ...EMPTY_SETTINGS,
      topics: ["Diplomatic relations"],
    });
    try {
      const res = await request(app)
        .post("/api/auth/resolve-destination")
        .send({ email: KNOWN_USER.email })
        .set("Content-Type", "application/json");
      assert.equal(res.status, 200);
      assert.equal(res.body.destination, "/dashboard");
      assert.deepEqual(res.body.user, { id: KNOWN_USER.id, email: KNOWN_USER.email });
    } finally {
      _resolveDestination.findUserByEmail = origFind;
      _resolveDestination.readSettingsForUser = origRead;
    }
  }));
