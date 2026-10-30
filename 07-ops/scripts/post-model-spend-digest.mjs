#!/usr/bin/env node
/**
 * Daily model spend digest → #ops-pricing-models.
 * v1 shell: posts placeholder until *_runs.estimated_cost_usd query is wired at build.
 * Env: TEMPO_OPS_SLACK_WEBHOOK_URL (omit → dry-run)
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const catalog = JSON.parse(
  readFileSync(join(root, "07-ops/model-pricing.json"), "utf8")
);

const yesterday = new Date();
yesterday.setUTCDate(yesterday.getUTCDate() - 1);
const day = yesterday.toISOString().slice(0, 10);

const lines = [
  `*Tempo model spend* (estimated from \`*_runs.estimated_cost_usd\`)`,
  `Day (UTC): \`${day}\` · rates SoT: \`07-ops/model-pricing.json\` @ \`${catalog.updated}\``,
  ``,
  `*$/day (lead)*`,
  `• \`TBD\` — sum run costs for yesterday UTC at build`,
  ``,
  `*By stage / model_id*`,
  `• extraction / summarization / story-tagging / metastory / personalization — TBD`,
  ``,
  `Null \`estimated_cost_usd\` rows: report count separately when wired.`,
  `Weekly unit catalog remains Monday catalog review. Channel: \`#ops-pricing-models\``,
];

const text = lines.join("\n");
const webhookUrl = (process.env.TEMPO_OPS_SLACK_WEBHOOK_URL ?? "").trim();

if (!webhookUrl) {
  console.log("[model-spend-digest] Dry run (TEMPO_OPS_SLACK_WEBHOOK_URL not set):\n");
  console.log(text);
  process.exit(0);
}

const res = await fetch(webhookUrl, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ text }),
});

if (!res.ok) {
  console.error(`[model-spend-digest] Slack HTTP ${res.status}`);
  process.exit(1);
}

console.log("[model-spend-digest] Posted to Slack");
