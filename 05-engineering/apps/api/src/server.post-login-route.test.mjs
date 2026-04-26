import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Isolated temp dir and no Supabase env so file adapter is always active.
const tmpDir = await mkdtemp(path.join(tmpdir(), "tempo-post-login-test-"));
process.env.TEMPO_DATA_DIR = tmpDir;
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.SUPABASE_ANON_KEY;

const { app, _auth } = await import("./server.mjs");
const { default: request } = await import("supertest");
const { writeSettings, DEFAULT_SETTINGS } = await import("./db/settings-repo.mjs");

const TEST_USER_ID = "post-login-test-user";
_auth.resolver = async () => TEST_USER_ID;

after(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

test("GET /api/auth/post-login-route returns 401 without valid token", async () => {
  const prev = _auth.resolver;
  _auth.resolver = async () => null;
  try {
    const res = await request(app).get("/api/auth/post-login-route");
    assert.equal(res.status, 401);
    assert.equal(typeof res.body.message, "string");
  } finally {
    _auth.resolver = prev;
  }
});

test("GET /api/auth/post-login-route returns /onboarding for new user with no settings", async () => {
  const res = await request(app).get("/api/auth/post-login-route");
  assert.equal(res.status, 200);
  assert.equal(res.body.destination, "/onboarding");
  assert.equal(res.body.reason, "new_user");
});

test("GET /api/auth/post-login-route returns /dashboard for returning user with existing settings", async () => {
  await writeSettings(DEFAULT_SETTINGS, TEST_USER_ID);
  const res = await request(app).get("/api/auth/post-login-route");
  assert.equal(res.status, 200);
  assert.equal(res.body.destination, "/dashboard");
  assert.equal(res.body.reason, "returning_user");
});
