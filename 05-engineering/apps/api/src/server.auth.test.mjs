import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Isolated data dir so this worker's DATA_DIR doesn't collide with other test workers.
const tmpDir = await mkdtemp(path.join(tmpdir(), "tempo-auth-test-"));
process.env.TEMPO_DATA_DIR = tmpDir;

const { app, _devMagicLink } = await import("./server.mjs");
const { default: request } = await import("supertest");

after(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ─── helpers ─────────────────────────────────────────────────────────────────

function withFlag(value, fn) {
  const prev = process.env.TEMPO_ENABLE_DEV_MAGIC_LINK;
  if (value === undefined) delete process.env.TEMPO_ENABLE_DEV_MAGIC_LINK;
  else process.env.TEMPO_ENABLE_DEV_MAGIC_LINK = value;
  return fn().finally(() => {
    if (prev !== undefined) process.env.TEMPO_ENABLE_DEV_MAGIC_LINK = prev;
    else delete process.env.TEMPO_ENABLE_DEV_MAGIC_LINK;
  });
}

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

// ─── Feature flag off (default) ──────────────────────────────────────────────

test("POST /api/auth/dev-magic-link returns 404 when TEMPO_ENABLE_DEV_MAGIC_LINK is unset", () =>
  withFlag(undefined, async () => {
    const res = await request(app)
      .post("/api/auth/dev-magic-link")
      .send({ email: "test@example.com", type: "login" })
      .set("Content-Type", "application/json");
    assert.equal(res.status, 404);
    assert.equal(typeof res.body.message, "string");
  }));

test("POST /api/auth/dev-magic-link returns 404 when flag is 'false'", () =>
  withFlag("false", async () => {
    const res = await request(app)
      .post("/api/auth/dev-magic-link")
      .send({ email: "test@example.com", type: "login" })
      .set("Content-Type", "application/json");
    assert.equal(res.status, 404);
  }));

// ─── Input validation ─────────────────────────────────────────────────────────

test("POST /api/auth/dev-magic-link returns 400 when email is missing", () =>
  withFlag("true", async () => {
    const res = await request(app)
      .post("/api/auth/dev-magic-link")
      .send({ type: "login" })
      .set("Content-Type", "application/json");
    assert.equal(res.status, 400);
    assert.ok(res.body.message.toLowerCase().includes("email"));
  }));

test("POST /api/auth/dev-magic-link returns 400 when email has no @", () =>
  withFlag("true", async () => {
    const res = await request(app)
      .post("/api/auth/dev-magic-link")
      .send({ email: "notvalid", type: "login" })
      .set("Content-Type", "application/json");
    assert.equal(res.status, 400);
    assert.ok(res.body.message.toLowerCase().includes("email"));
  }));

test("POST /api/auth/dev-magic-link returns 400 when type is missing", () =>
  withFlag("true", async () => {
    const res = await request(app)
      .post("/api/auth/dev-magic-link")
      .send({ email: "test@example.com" })
      .set("Content-Type", "application/json");
    assert.equal(res.status, 400);
    assert.ok(res.body.message.toLowerCase().includes("type"));
  }));

test("POST /api/auth/dev-magic-link returns 400 when type is invalid", () =>
  withFlag("true", async () => {
    const res = await request(app)
      .post("/api/auth/dev-magic-link")
      .send({ email: "test@example.com", type: "magic" })
      .set("Content-Type", "application/json");
    assert.equal(res.status, 400);
    assert.ok(res.body.message.toLowerCase().includes("type"));
  }));

test("POST /api/auth/dev-magic-link returns 400 when redirectTo is a non-localhost origin", () =>
  withFlag("true", async () => {
    const res = await request(app)
      .post("/api/auth/dev-magic-link")
      .send({ email: "test@example.com", type: "login", redirectTo: "https://attacker.com/steal" })
      .set("Content-Type", "application/json");
    assert.equal(res.status, 400);
    assert.ok(res.body.message.toLowerCase().includes("localhost"));
  }));

test("POST /api/auth/dev-magic-link returns 400 when redirectTo is an unparseable URL", () =>
  withFlag("true", async () => {
    const res = await request(app)
      .post("/api/auth/dev-magic-link")
      .send({ email: "test@example.com", type: "signup", redirectTo: "not a url at all" })
      .set("Content-Type", "application/json");
    assert.equal(res.status, 400);
    assert.ok(res.body.message.toLowerCase().includes("localhost"));
  }));

// ─── Missing Supabase config ──────────────────────────────────────────────────

test("POST /api/auth/dev-magic-link returns 503 when SUPABASE_URL is unset", () =>
  withFlag("true", async () =>
    withSupabase(undefined, undefined, async () => {
      const res = await request(app)
        .post("/api/auth/dev-magic-link")
        .send({ email: "test@example.com", type: "login" })
        .set("Content-Type", "application/json");
      assert.equal(res.status, 503);
      assert.ok(res.body.message.includes("SUPABASE_URL"));
    })
  ));

test("POST /api/auth/dev-magic-link returns 503 when SUPABASE_SERVICE_ROLE_KEY is unset", () =>
  withFlag("true", async () =>
    withSupabase("https://example.supabase.co", undefined, async () => {
      const res = await request(app)
        .post("/api/auth/dev-magic-link")
        .send({ email: "test@example.com", type: "signup" })
        .set("Content-Type", "application/json");
      assert.equal(res.status, 503);
      assert.ok(res.body.message.includes("SUPABASE_SERVICE_ROLE_KEY"));
    })
  ));

// ─── Success paths — mock generateLink to avoid live Supabase ────────────────

test("POST /api/auth/dev-magic-link login path generates 'magiclink' type", () =>
  withFlag("true", async () =>
    withSupabase("https://example.supabase.co", "fake-service-role-key", async () => {
      let capturedType = null;
      const orig = _devMagicLink.generateLink;
      _devMagicLink.generateLink = async ({ supabaseType }) => {
        capturedType = supabaseType;
        return "https://example.supabase.co/auth/v1/verify?token=mock-login-token";
      };
      try {
        const res = await request(app)
          .post("/api/auth/dev-magic-link")
          .send({
            email: "user@example.com",
            type: "login",
            redirectTo: "http://localhost:4173/auth/callback?type=login",
          })
          .set("Content-Type", "application/json");
        assert.equal(res.status, 200);
        assert.equal(typeof res.body.url, "string");
        assert.ok(res.body.url.includes("mock-login-token"));
        assert.equal(capturedType, "magiclink", "login must use magiclink type");
      } finally {
        _devMagicLink.generateLink = orig;
      }
    })
  ));

test("POST /api/auth/dev-magic-link signup path generates 'signup' type", () =>
  withFlag("true", async () =>
    withSupabase("https://example.supabase.co", "fake-service-role-key", async () => {
      let capturedType = null;
      const orig = _devMagicLink.generateLink;
      _devMagicLink.generateLink = async ({ supabaseType }) => {
        capturedType = supabaseType;
        return "https://example.supabase.co/auth/v1/verify?token=mock-signup-token";
      };
      try {
        const res = await request(app)
          .post("/api/auth/dev-magic-link")
          .send({
            email: "newuser@example.com",
            type: "signup",
            redirectTo: "http://127.0.0.1:4173/auth/callback?type=signup",
          })
          .set("Content-Type", "application/json");
        assert.equal(res.status, 200);
        assert.equal(typeof res.body.url, "string");
        assert.ok(res.body.url.includes("mock-signup-token"));
        assert.equal(capturedType, "signup", "signup must use signup type");
      } finally {
        _devMagicLink.generateLink = orig;
      }
    })
  ));

// ─── generateLink failure ─────────────────────────────────────────────────────

test("POST /api/auth/dev-magic-link returns 502 when generateLink throws", () =>
  withFlag("true", async () =>
    withSupabase("https://example.supabase.co", "fake-service-role-key", async () => {
      const orig = _devMagicLink.generateLink;
      _devMagicLink.generateLink = async () => {
        throw new Error("Supabase admin API unavailable");
      };
      try {
        const res = await request(app)
          .post("/api/auth/dev-magic-link")
          .send({ email: "test@example.com", type: "login" })
          .set("Content-Type", "application/json");
        assert.equal(res.status, 502);
        assert.equal(typeof res.body.message, "string");
      } finally {
        _devMagicLink.generateLink = orig;
      }
    })
  ));
