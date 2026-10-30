#!/usr/bin/env node
/**
 * Daily ingestion spend digest → #ops-pricing-ingestion.
 * v1 shell: posts placeholder until PostHog facts + SKU rates exist at build.
 * Env: TEMPO_OPS_SLACK_WEBHOOK_URL_INGESTION (omit → dry-run)
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const catalog = JSON.parse(
  readFileSync(join(root, "07-ops/ingestion-pricing.json"), "utf8")
);

const yesterday = new Date();
yesterday.setUTCDate(yesterday.getUTCDate() - 1);
const day = yesterday.toISOString().slice(0, 10);

const lines = [
  `*Tempo ingestion spend* (estimated)`,
  `Day (UTC): \`${day}\` · rates SoT: \`07-ops/ingestion-pricing.json\` @ \`${catalog.updated}\``,
  ``,
  `*$/day (lead)*`,
  `• \`TBD\` — wire PostHog \`ingestion_job_completed\` × stamped SKUs at build`,
  ``,
  `*$/run + by job_kind*`,
  `• clock / warm / IR-14 / compliance — TBD`,
  ``,
  `Per-call detail: omitted in v1 (optional later).`,
  `No MVP spend caps. Channel: \`#ops-pricing-ingestion\``,
];

const text = lines.join("\n");
const webhookUrl = (process.env.TEMPO_OPS_SLACK_WEBHOOK_URL_INGESTION ?? "").trim();

if (!webhookUrl) {
  console.log("[ingestion-spend-digest] Dry run (TEMPO_OPS_SLACK_WEBHOOK_URL_INGESTION not set):\n");
  console.log(text);
  process.exit(0);
}

const res = await fetch(webhookUrl, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ text }),
});

if (!res.ok) {
  console.error(`[ingestion-spend-digest] Slack HTTP ${res.status}`);
  process.exit(1);
}

console.log("[ingestion-spend-digest] Posted to Slack");
