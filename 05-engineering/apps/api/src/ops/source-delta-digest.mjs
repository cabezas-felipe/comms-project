/**
 * source-delta-digest.mjs
 *
 * Queries v_source_net_new_24h and sends a Slack digest of net-new sources.
 * Dry-runs to stdout when SOURCE_DIGEST_SLACK_WEBHOOK_URL is not set.
 *
 * Required env vars:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Optional env vars:
 *   SOURCE_DIGEST_SLACK_WEBHOOK_URL  — Incoming Webhook URL; omit for dry-run
 */

import "dotenv/config";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

const NET_NEW_VIEW = "v_source_net_new_24h";

/** @param {string} ts  ISO 8601 timestamp string */
function fmtTs(ts) {
  return new Date(ts).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

/**
 * Formats digest rows into a Slack-compatible text block.
 * Exported for unit testing without I/O.
 *
 * @param {Array<{raw_string: string, kind: string, times_seen: number, first_seen_at: string}>} rows
 * @param {string} asOf  YYYY-MM-DD date string for the digest header
 * @returns {string}
 */
export function formatDigest(rows, asOf) {
  const count = rows.length;
  const lines = [
    `*Source digest — ${asOf}* (${count} unmapped source${count === 1 ? "" : "s"})`,
  ];

  const trad = rows.filter((r) => r.kind === "traditional");
  const social = rows.filter((r) => r.kind === "social");

  if (trad.length > 0) {
    lines.push("", "*Traditional*");
    for (const r of trad) {
      lines.push(`  • \`${r.raw_string}\` — seen ${r.times_seen}x (first: ${fmtTs(r.first_seen_at)})`);
    }
  }

  if (social.length > 0) {
    lines.push("", "*Social*");
    for (const r of social) {
      lines.push(`  • \`${r.raw_string}\` — seen ${r.times_seen}x (first: ${fmtTs(r.first_seen_at)})`);
    }
  }

  lines.push("", "_Map sources: see SOURCE-REGISTRY-PHASE2-PLAYBOOK.md_");
  return lines.join("\n");
}

async function sendSlack(webhookUrl, text) {
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    throw new Error(`Slack webhook returned HTTP ${res.status}`);
  }
}

export async function run({
  supabaseUrl = process.env.SUPABASE_URL,
  serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY,
  webhookUrl = process.env.SOURCE_DIGEST_SLACK_WEBHOOK_URL,
} = {}) {
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  const { data, error } = await supabase.from(NET_NEW_VIEW).select("*");

  if (error) {
    throw new Error(`Query failed: ${error.message}`);
  }

  if (!data || data.length === 0) {
    console.log("[digest] no new sources in last 24h — nothing to send");
    return { sent: false, count: 0 };
  }

  const asOf = new Date().toISOString().slice(0, 10);
  const message = formatDigest(data, asOf);

  if (!webhookUrl) {
    console.log("[digest] dry-run (SOURCE_DIGEST_SLACK_WEBHOOK_URL not set):\n");
    console.log(message);
    return { sent: false, count: data.length, dryRun: true };
  }

  await sendSlack(webhookUrl, message);
  console.log(`[digest] sent ${data.length} source(s) to Slack`);
  return { sent: true, count: data.length };
}

// Only execute when invoked directly (not when imported by tests)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().catch((err) => {
    console.error(`[digest] fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
