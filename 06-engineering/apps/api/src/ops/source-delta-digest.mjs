// Daily source delta digest — queries v_source_net_new_24h and posts to Slack.
//
// Required env vars:  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Optional env vars:  SOURCE_DIGEST_SLACK_WEBHOOK_URL  (omit → dry-run to stdout)

import "dotenv/config";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

function requireEnv(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

/**
 * Builds a Slack-friendly markdown digest from view rows.
 * Rows are sorted deterministically: highest times_seen first, then earliest
 * first_seen_at as a tie-breaker. Grouping: Traditional before Social.
 *
 * @param {Array<{raw_string:string, kind:string, times_seen:number, first_seen_at:string, last_seen_at:string}>} rows
 * @param {Date} asOf
 * @returns {string}
 */
export function formatDigest(rows, asOf) {
  const dateLabel = asOf.toISOString().slice(0, 10);

  if (rows.length === 0) {
    return `*Daily source digest — ${dateLabel}*\nNo unmapped sources in the last 24 hours.`;
  }

  const sorted = [...rows].sort(
    (a, b) =>
      b.times_seen - a.times_seen ||
      new Date(a.first_seen_at) - new Date(b.first_seen_at)
  );

  const traditional = sorted.filter((r) => r.kind === "traditional");
  const social = sorted.filter((r) => r.kind === "social");
  const lines = [`*Daily source digest — ${dateLabel}* (${rows.length} unmapped)`];

  const formatRow = (r) => {
    const last = String(r.last_seen_at).slice(0, 16) + "Z";
    return `• ${r.raw_string} — seen ${r.times_seen}× (last: ${last})`;
  };

  if (traditional.length > 0) {
    lines.push(`\n*Traditional (${traditional.length})*`);
    traditional.forEach((r) => lines.push(formatRow(r)));
  }

  if (social.length > 0) {
    lines.push(`\n*Social (${social.length})*`);
    social.forEach((r) => lines.push(formatRow(r)));
  }

  return lines.join("\n");
}

async function run() {
  const supabaseUrl = requireEnv("SUPABASE_URL");
  const supabaseKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

  const client = createClient(supabaseUrl, supabaseKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: rows, error } = await client.from("v_source_net_new_24h").select("*");
  if (error) throw new Error(`Query failed: ${error.message}`);

  if (rows.length === 0) {
    console.log("[source-digest] No unmapped sources in the last 24 hours — nothing to report.");
    return;
  }

  const message = formatDigest(rows, new Date());
  const webhookUrl = process.env.SOURCE_DIGEST_SLACK_WEBHOOK_URL;

  if (!webhookUrl) {
    console.log("[source-digest] Dry run (SOURCE_DIGEST_SLACK_WEBHOOK_URL not set):\n");
    console.log(message);
    return;
  }

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: message }),
  });

  if (!res.ok) {
    throw new Error(`Slack webhook failed: ${res.status} ${await res.text()}`);
  }
  console.log(`[source-digest] Posted ${rows.length} unmapped sources to Slack.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().catch((err) => {
    console.error(`[source-digest] Fatal: ${err.message}`);
    process.exit(1);
  });
}
