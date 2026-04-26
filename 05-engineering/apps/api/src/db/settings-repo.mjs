import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertSupabaseEnv, getSupabaseClient } from "./client.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Resolve two levels up from src/db/ → package root
const PACKAGE_ROOT = path.resolve(__dirname, "../..");

export const DEFAULT_SETTINGS = {
  contractVersion: "2026-04-22-slice1",
  topics: ["Diplomatic relations", "Migration policy", "Security cooperation"],
  keywords: ["OFAC", "sanctions", "deportation routing", "bilateral"],
  geographies: ["US", "Colombia"],
  traditionalSources: ["The New York Times", "Reuters", "El Tiempo"],
  socialSources: ["@latamwatcher"],
};

const GLOBAL_KEY = "global_settings";

function userKey(userId) {
  return `user:${userId}`;
}

// ─── File adapter ─────────────────────────────────────────────────────────────

function resolveSettingsFile(userId = null) {
  const dataDir = process.env.TEMPO_DATA_DIR ?? path.join(PACKAGE_ROOT, "data");
  const filename = userId ? `settings_user_${userId}.json` : "settings.json";
  return path.join(dataDir, filename);
}

async function ensureSettingsFile(settingsFile) {
  await fs.mkdir(path.dirname(settingsFile), { recursive: true });
  try {
    await fs.access(settingsFile);
  } catch {
    await fs.writeFile(settingsFile, JSON.stringify(DEFAULT_SETTINGS, null, 2), "utf8");
  }
}

async function readSettingsFile(userId = null) {
  const file = resolveSettingsFile(userId);
  await ensureSettingsFile(file);
  const content = await fs.readFile(file, "utf8");
  return JSON.parse(content);
}

async function writeSettingsFile(payload, userId = null) {
  const file = resolveSettingsFile(userId);
  await ensureSettingsFile(file);
  await fs.writeFile(file, JSON.stringify(payload, null, 2), "utf8");
}

// ─── Supabase adapter ─────────────────────────────────────────────────────────

async function readSettingsSupabase(userId = null) {
  const client = getSupabaseClient();
  const key = userId ? userKey(userId) : GLOBAL_KEY;
  const { data, error } = await client
    .from("settings")
    .select("data")
    .eq("key", key)
    .maybeSingle();
  if (error) throw new Error(`[supabase] settings read failed: ${error.message}`);
  return data?.data ?? DEFAULT_SETTINGS;
}

async function writeSettingsSupabase(payload, userId = null) {
  const client = getSupabaseClient();
  const key = userId ? userKey(userId) : GLOBAL_KEY;
  const { error } = await client.from("settings").upsert({
    key,
    data: payload,
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(`[supabase] settings write failed: ${error.message}`);
}

// ─── Public API ───────────────────────────────────────────────────────────────

async function hasSettingsFile(userId = null) {
  const file = resolveSettingsFile(userId);
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function hasSettingsSupabase(userId = null) {
  const client = getSupabaseClient();
  const key = userId ? userKey(userId) : GLOBAL_KEY;
  const { data, error } = await client
    .from("settings")
    .select("key")
    .eq("key", key)
    .maybeSingle();
  if (error) throw new Error(`[supabase] settings check failed: ${error.message}`);
  return data !== null;
}

/**
 * Non-destructive existence check. Returns true if settings exist for the user.
 * Never auto-creates defaults. Uses Supabase if SUPABASE_URL is set, file-based otherwise.
 */
export async function hasSettings(userId = null) {
  if (process.env.SUPABASE_URL) {
    assertSupabaseEnv();
    return hasSettingsSupabase(userId);
  }
  return hasSettingsFile(userId);
}

/**
 * Read settings for a user (or global when userId is null).
 * Uses Supabase if SUPABASE_URL is set, file-based otherwise.
 */
export async function readSettings(userId = null) {
  if (process.env.SUPABASE_URL) {
    assertSupabaseEnv();
    return readSettingsSupabase(userId);
  }
  return readSettingsFile(userId);
}

/**
 * Persist settings for a user (or global when userId is null).
 * Uses Supabase if SUPABASE_URL is set, file-based otherwise.
 */
export async function writeSettings(payload, userId = null) {
  if (process.env.SUPABASE_URL) {
    assertSupabaseEnv();
    return writeSettingsSupabase(payload, userId);
  }
  return writeSettingsFile(payload, userId);
}
