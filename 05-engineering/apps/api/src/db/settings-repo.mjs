import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertSupabaseEnv, getSupabaseClient } from "./client.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Resolve two levels up from src/db/ → package root
const PACKAGE_ROOT = path.resolve(__dirname, "../..");

const SETTINGS_KEY = "global_settings";

export const DEFAULT_SETTINGS = {
  contractVersion: "2026-04-22-slice1",
  topics: ["Diplomatic relations", "Migration policy", "Security cooperation"],
  keywords: ["OFAC", "sanctions", "deportation routing", "bilateral"],
  geographies: ["US", "Colombia"],
  traditionalSources: ["The New York Times", "Reuters", "El Tiempo"],
  socialSources: ["@latamwatcher"],
};

// ─── File adapter ─────────────────────────────────────────────────────────────

function resolveSettingsFile() {
  const dataDir = process.env.TEMPO_DATA_DIR ?? path.join(PACKAGE_ROOT, "data");
  return path.join(dataDir, "settings.json");
}

async function ensureSettingsFile(settingsFile) {
  await fs.mkdir(path.dirname(settingsFile), { recursive: true });
  try {
    await fs.access(settingsFile);
  } catch {
    await fs.writeFile(settingsFile, JSON.stringify(DEFAULT_SETTINGS, null, 2), "utf8");
  }
}

async function readSettingsFile() {
  const file = resolveSettingsFile();
  await ensureSettingsFile(file);
  const content = await fs.readFile(file, "utf8");
  return JSON.parse(content);
}

async function writeSettingsFile(payload) {
  const file = resolveSettingsFile();
  await ensureSettingsFile(file);
  await fs.writeFile(file, JSON.stringify(payload, null, 2), "utf8");
}

// ─── Supabase adapter ─────────────────────────────────────────────────────────

async function readSettingsSupabase() {
  const client = getSupabaseClient();
  const { data, error } = await client
    .from("settings")
    .select("data")
    .eq("key", SETTINGS_KEY)
    .maybeSingle();
  if (error) throw new Error(`[supabase] settings read failed: ${error.message}`);
  return data?.data ?? DEFAULT_SETTINGS;
}

async function writeSettingsSupabase(payload) {
  const client = getSupabaseClient();
  const { error } = await client.from("settings").upsert({
    key: SETTINGS_KEY,
    data: payload,
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(`[supabase] settings write failed: ${error.message}`);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Read current settings. Uses Supabase if SUPABASE_URL is set (fails fast on partial config), file-based otherwise. */
export async function readSettings() {
  if (process.env.SUPABASE_URL) {
    assertSupabaseEnv();
    return readSettingsSupabase();
  }
  return readSettingsFile();
}

/** Persist settings. Uses Supabase if SUPABASE_URL is set (fails fast on partial config), file-based otherwise. */
export async function writeSettings(payload) {
  if (process.env.SUPABASE_URL) {
    assertSupabaseEnv();
    return writeSettingsSupabase(payload);
  }
  return writeSettingsFile(payload);
}
