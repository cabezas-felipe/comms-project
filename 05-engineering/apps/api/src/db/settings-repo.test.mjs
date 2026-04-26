import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Isolated temp dir; no Supabase env so file adapter is always active.
const tmpDir = await mkdtemp(path.join(tmpdir(), "tempo-settings-repo-test-"));
process.env.TEMPO_DATA_DIR = tmpDir;
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.SUPABASE_ANON_KEY;

const { readSettings, writeSettings, hasSettings, DEFAULT_SETTINGS } = await import("./settings-repo.mjs");
const { isSupabaseEnabled, assertSupabaseEnv } = await import("./client.mjs");

after(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

test("readSettings returns default settings when no file exists", async () => {
  const settings = await readSettings();
  assert.equal(settings.contractVersion, DEFAULT_SETTINGS.contractVersion);
  assert.ok(Array.isArray(settings.topics));
  assert.ok(settings.topics.length > 0);
  assert.deepEqual(settings.geographies, DEFAULT_SETTINGS.geographies);
});

test("writeSettings persists and readSettings returns updated data", async () => {
  const update = {
    ...DEFAULT_SETTINGS,
    topics: ["Custom topic"],
    keywords: ["test-keyword"],
  };
  await writeSettings(update);
  const result = await readSettings();
  assert.deepEqual(result.topics, ["Custom topic"]);
  assert.deepEqual(result.keywords, ["test-keyword"]);
  assert.equal(result.contractVersion, DEFAULT_SETTINGS.contractVersion);
});

test("isSupabaseEnabled returns false when env vars are absent", () => {
  assert.equal(isSupabaseEnabled(), false);
});

test("assertSupabaseEnv throws mentioning SUPABASE_URL when missing", () => {
  // SUPABASE_URL was deleted at module load time above
  assert.throws(
    () => assertSupabaseEnv(),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.includes("SUPABASE_URL"),
        `expected message to reference SUPABASE_URL, got: ${err.message}`
      );
      return true;
    }
  );
});

test("assertSupabaseEnv throws mentioning key var when URL is set but key is absent", () => {
  const prev = process.env.SUPABASE_URL;
  process.env.SUPABASE_URL = "https://example.supabase.co";
  try {
    assert.throws(
      () => assertSupabaseEnv(),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes("SUPABASE_SERVICE_ROLE_KEY") || err.message.includes("SUPABASE_ANON_KEY"),
          `expected message to reference a key var, got: ${err.message}`
        );
        return true;
      }
    );
  } finally {
    if (prev === undefined) {
      delete process.env.SUPABASE_URL;
    } else {
      process.env.SUPABASE_URL = prev;
    }
  }
});

test("readSettings rejects with missing key message when SUPABASE_URL is set but key vars are absent", async () => {
  process.env.SUPABASE_URL = "https://example.supabase.co";
  try {
    await assert.rejects(
      () => readSettings(),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes("SUPABASE_SERVICE_ROLE_KEY") || err.message.includes("SUPABASE_ANON_KEY"),
          `expected message to reference a key var, got: ${err.message}`
        );
        return true;
      }
    );
  } finally {
    delete process.env.SUPABASE_URL;
  }
});

test("readSettings uses file adapter when SUPABASE_URL is unset", async () => {
  // SUPABASE_URL is unset (cleared at module load time above)
  const settings = await readSettings();
  assert.ok(typeof settings === "object");
  assert.ok(Array.isArray(settings.topics));
  assert.ok(settings.topics.length > 0);
});

test("hasSettings returns false when no settings file exists for a user", async () => {
  const result = await hasSettings("has-settings-new-user");
  assert.equal(result, false);
});

test("hasSettings returns true after writeSettings is called for a user", async () => {
  const userId = "has-settings-existing-user";
  await writeSettings(DEFAULT_SETTINGS, userId);
  const result = await hasSettings(userId);
  assert.equal(result, true);
});

test("hasSettings does not create a settings file as a side effect", async () => {
  const { access } = await import("node:fs/promises");
  const userId = "has-settings-no-side-effect";
  const filePath = path.join(tmpDir, `settings_user_${userId}.json`);
  await hasSettings(userId);
  await assert.rejects(
    () => access(filePath),
    "settings file must not exist after hasSettings call on a new user"
  );
});
