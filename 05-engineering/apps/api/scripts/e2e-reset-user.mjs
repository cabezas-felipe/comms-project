#!/usr/bin/env node
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getSupabaseClient, isSupabaseEnabled } from "../src/db/client.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env"), override: false });

function parseArgs(argv) {
  const out = { userId: null, email: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--user-id") out.userId = argv[++i];
    else if (a === "--email") out.email = argv[++i];
    else if (a === "--dry-run") out.dryRun = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!out.userId) {
    throw new Error("Missing required argument: --user-id <uuid>");
  }
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

async function deleteByUser(supabase, table, userId) {
  const { error } = await supabase.from(table).delete().eq("user_id", userId);
  if (error) throw new Error(`[${table}] delete failed: ${error.message}`);
}

async function deleteSettingsRows(supabase, userId) {
  const { error } = await supabase.from("settings").delete().like("key", `%${userId}%`);
  if (error) throw new Error(`[settings] delete failed: ${error.message}`);
}

async function run() {
  const { userId, email, dryRun } = parseArgs(process.argv.slice(2));
  if (!isSupabaseEnabled()) {
    throw new Error(
      "Supabase is not enabled. Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY before running e2e reset."
    );
  }

  const supabase = getSupabaseClient();
  const before = {
    dashboard_snapshots: await countByUser(supabase, "dashboard_snapshots", userId),
    meta_story_locks: await countByUser(supabase, "meta_story_locks", userId),
    story_rejections: await countByUser(supabase, "story_rejections", userId),
    geo_hold_bucket: await countByUser(supabase, "geo_hold_bucket", userId),
    user_onboarding_narratives: await countByUser(supabase, "user_onboarding_narratives", userId),
    settings: await countSettingsRows(supabase, userId),
  };

  console.log(
    `[e2e:reset-user] target user_id=${userId}` + (email ? ` email=${email}` : "")
  );
  console.log(`[e2e:reset-user] before=${JSON.stringify(before)}`);

  if (dryRun) {
    console.log("[e2e:reset-user] dry-run=true (no deletes applied)");
    return;
  }

  await deleteByUser(supabase, "dashboard_snapshots", userId);
  await deleteByUser(supabase, "meta_story_locks", userId);
  await deleteByUser(supabase, "story_rejections", userId);
  await deleteByUser(supabase, "geo_hold_bucket", userId);
  await deleteByUser(supabase, "user_onboarding_narratives", userId);
  await deleteSettingsRows(supabase, userId);

  const after = {
    dashboard_snapshots: await countByUser(supabase, "dashboard_snapshots", userId),
    meta_story_locks: await countByUser(supabase, "meta_story_locks", userId),
    story_rejections: await countByUser(supabase, "story_rejections", userId),
    geo_hold_bucket: await countByUser(supabase, "geo_hold_bucket", userId),
    user_onboarding_narratives: await countByUser(supabase, "user_onboarding_narratives", userId),
    settings: await countSettingsRows(supabase, userId),
  };
  console.log(`[e2e:reset-user] after=${JSON.stringify(after)}`);
}

run().catch((err) => {
  console.error(`[e2e:reset-user] ${err?.message ?? err}`);
  process.exitCode = 1;
});
