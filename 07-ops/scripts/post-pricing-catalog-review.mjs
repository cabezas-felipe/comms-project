#!/usr/bin/env node
/**
 * Weekly catalog heartbeat / review for model-pricing or ingestion-pricing.
 * Until doc-diff parsers ship: always post status=in_sync (or STUB) + stamped catalog.
 * Env:
 *   CATALOG=model|ingestion (required)
 *   TEMPO_OPS_SLACK_WEBHOOK_URL (model) or TEMPO_OPS_SLACK_WEBHOOK_URL_INGESTION
 *   PRICING_DIFF_STATUS=in_sync|drift|fetch_fail (optional; default in_sync)
 * Omit webhook → dry-run stdout.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const catalogKind = (process.env.CATALOG ?? "").trim().toLowerCase();
const status = (process.env.PRICING_DIFF_STATUS ?? "in_sync").trim();

if (catalogKind !== "model" && catalogKind !== "ingestion") {
  console.error("[pricing-catalog-review] Set CATALOG=model|ingestion");
  process.exit(1);
}

const isModel = catalogKind === "model";
const relPath = isModel ? "07-ops/model-pricing.json" : "07-ops/ingestion-pricing.json";
const channel = isModel ? "#ops-pricing-models" : "#ops-pricing-ingestion";
const webhookEnv = isModel
  ? "TEMPO_OPS_SLACK_WEBHOOK_URL"
  : "TEMPO_OPS_SLACK_WEBHOOK_URL_INGESTION";
const catalog = JSON.parse(readFileSync(join(root, relPath), "utf8"));

const lines = [
  `*Tempo ${catalogKind} pricing catalog* (\`${relPath}\`)`,
  `Status: \`${status}\` · catalog updated: \`${catalog.updated}\` · currency ${catalog.currency}`,
  ``,
];

if (isModel) {
  lines.push(`Unit: ${catalog.unit}`, ``, `*Stamped rates (input / output per MTok)*`);
  for (const [id, rates] of Object.entries(catalog.models || {})) {
    lines.push(
      `• \`${id}\` (${rates.provider}): $${rates.inputPerMTok} / $${rates.outputPerMTok}`
    );
  }
  lines.push(
    ``,
    `*Review URLs (do not fetch on LLM runs)*`,
    `• Anthropic: ${catalog.review_urls?.anthropic ?? "(missing)"}`,
    `• OpenAI: ${catalog.review_urls?.openai ?? "(missing)"}`,
    ``,
    `If rates changed: edit \`07-ops/model-pricing.json\` → \`node 07-ops/scripts/sync-model-pricing.mjs\` → PR + DECISIONS note.`,
    `Target: auto doc-diff → alert on drift; human merge. Parser TBD at build.`
  );
} else {
  const skus = catalog.skus || {};
  const skuKeys = Object.keys(skus);
  lines.push(
    `*Stamped SKUs*`,
    skuKeys.length === 0
      ? `• _(none yet — fill at build)_`
      : skuKeys.map((k) => `• \`${k}\`: ${JSON.stringify(skus[k])}`).join("\n"),
    ``,
    `*Review URLs (do not fetch on ingest runs)*`,
    `• NewsAPI.ai: ${catalog.review_urls?.newsapi_ai_plans ?? "(missing)"}`,
    `• X: ${catalog.review_urls?.x_api_pricing ?? "(missing)"}`,
    ``,
    `If rates changed: edit \`07-ops/ingestion-pricing.json\` → PR + DECISIONS note.`,
    `Target: auto doc-diff → alert on drift; human merge. Parser TBD at build.`
  );
}

lines.push(``, `Channel: \`${channel}\``);

const text = lines.join("\n");
const webhookUrl = (process.env[webhookEnv] ?? "").trim();
const tag = `[pricing-catalog-review:${catalogKind}]`;

if (!webhookUrl) {
  console.log(`${tag} Dry run (${webhookEnv} not set):\n`);
  console.log(text);
  process.exit(0);
}

const res = await fetch(webhookUrl, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ text }),
});

if (!res.ok) {
  console.error(`${tag} Slack HTTP ${res.status}`);
  process.exit(1);
}

console.log(`${tag} Posted to Slack (${status})`);
