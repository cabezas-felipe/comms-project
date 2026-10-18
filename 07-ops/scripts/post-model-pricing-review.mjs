#!/usr/bin/env node
/**
 * Weekly ops notice: current model-pricing.json + provider review links → Slack.
 * Env: TEMPO_OPS_SLACK_WEBHOOK_URL (omit → dry-run stdout)
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const catalog = JSON.parse(readFileSync(join(root, "07-ops/model-pricing.json"), "utf8"));

const lines = [
  `*Tempo model pricing review* (\`07-ops/model-pricing.json\`)`,
  `Catalog updated: \`${catalog.updated}\` · currency ${catalog.currency} · ${catalog.unit}`,
  ``,
  `*Stamped rates (input / output per MTok)*`,
];

for (const [id, rates] of Object.entries(catalog.models || {})) {
  lines.push(
    `• \`${id}\` (${rates.provider}): $${rates.inputPerMTok} / $${rates.outputPerMTok}`
  );
}

lines.push(
  ``,
  `*Verify against provider pages (do not scrape on LLM runs)*`,
  `• Anthropic: ${catalog.review_urls?.anthropic ?? "(missing)"}`,
  `• OpenAI: ${catalog.review_urls?.openai ?? "(missing)"}`,
  ``,
  `If rates changed: edit \`07-ops/model-pricing.json\` → \`node 07-ops/scripts/sync-model-pricing.mjs\` → PR + DECISIONS note.`,
  `Channel: \`#ops-pricing-models\``
);

const text = lines.join("\n");
const webhookUrl = (process.env.TEMPO_OPS_SLACK_WEBHOOK_URL ?? "").trim();

if (!webhookUrl) {
  console.log("[model-pricing-review] Dry run (TEMPO_OPS_SLACK_WEBHOOK_URL not set):\n");
  console.log(text);
  process.exit(0);
}

const res = await fetch(webhookUrl, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ text }),
});

if (!res.ok) {
  console.error(`[model-pricing-review] Slack HTTP ${res.status}`);
  process.exit(1);
}

console.log("[model-pricing-review] Posted to Slack");
