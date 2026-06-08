#!/usr/bin/env node
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getSupabaseClient, isSupabaseEnabled } from "../src/db/client.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env"), override: false });

function parseArgs(argv) {
  const out = { userId: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--user-id") out.userId = argv[++i];
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!out.userId) throw new Error("Missing required argument: --user-id <uuid>");
  return out;
}

async function countByUser(supabase, table, userId) {
  const { count, error } = await supabase
    .from(table)
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId);
  if (error) throw new Error(`[${table}] count failed: ${error.message}`);
  return count ?? 0;
}

async function countSettingsRows(supabase, userId) {
  const { count, error } = await supabase
    .from("settings")
    .select("*", { count: "exact", head: true })
    .like("key", `%${userId}%`);
  if (error) throw new Error(`[settings] count failed: ${error.message}`);
  return count ?? 0;
}

async function run() {
  const { userId } = parseArgs(process.argv.slice(2));
  if (!isSupabaseEnabled()) {
    throw new Error(
      "Supabase is not enabled. Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY before running e2e assert-clean."
    );
  }
  const supabase = getSupabaseClient();
  const counts = {
    dashboard_snapshots: await countByUser(supabase, "dashboard_snapshots", userId),
    meta_story_locks: await countByUser(supabase, "meta_story_locks", userId),
    story_rejections: await countByUser(supabase, "story_rejections", userId),
    geo_hold_bucket: await countByUser(supabase, "geo_hold_bucket", userId),
    user_onboarding_narratives: await countByUser(supabase, "user_onboarding_narratives", userId),
    settings: await countSettingsRows(supabase, userId),
  };
  const dirty = Object.entries(counts).filter(([, v]) => v !== 0);
  if (dirty.length > 0) {
    console.error(`[e2e:assert-clean] FAIL user_id=${userId} counts=${JSON.stringify(counts)}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[e2e:assert-clean] PASS user_id=${userId} counts=${JSON.stringify(counts)}`);
}

run().catch((err) => {
  console.error(`[e2e:assert-clean] ${err?.message ?? err}`);
  process.exitCode = 1;
});
