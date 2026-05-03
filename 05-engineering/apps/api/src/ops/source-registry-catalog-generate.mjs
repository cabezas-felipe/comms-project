// Source registry catalog generator — reads source_feed_mapping + source_entities
// from Supabase and writes a read-only Markdown catalog for PM review.
//
// Required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Output: 05-engineering/SOURCE-REGISTRY-CATALOG.generated.md

import "dotenv/config";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";

const STATUS_ORDER = ["verified", "mapped", "pending", "rejected"];

const TABLE_HEADER =
  "| Name | Kind | Status | Feed URL | Manifest ID | Weight | Active | Updated |\n" +
  "| ---- | ---- | ------ | -------- | ----------- | ------ | ------ | ------- |";

function requireEnv(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

function statusRank(status) {
  const idx = STATUS_ORDER.indexOf(status);
  return idx === -1 ? STATUS_ORDER.length : idx;
}

function dash(val) {
  if (val === null || val === undefined || val === "") return "—";
  return String(val);
}

function formatFeedUrl(row) {
  return dash(row.rss_url || row.social_profile_url || null);
}

function formatBool(val) {
  if (val === null || val === undefined) return "—";
  return val ? "yes" : "no";
}

function formatDate(val) {
  if (!val) return "—";
  return String(val).slice(0, 10);
}

function tableRow(row) {
  const cols = [
    dash(row.canonical_name),
    dash(row.kind),
    dash(row.status),
    formatFeedUrl(row),
    dash(row.manifest_feed_id),
    dash(row.ingestion_weight),
    formatBool(row.active),
    formatDate(row.updated_at || row.created_at),
  ];
  return `| ${cols.join(" | ")} |`;
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Sorts rows deterministically:
 *   1. status order: verified → mapped → pending → rejected
 *   2. ingestion_weight DESC
 *   3. canonical_name ASC
 *
 * Never mutates the input array.
 */
export function sortRows(rows) {
  return [...rows].sort((a, b) => {
    const sd = statusRank(a.status) - statusRank(b.status);
    if (sd !== 0) return sd;
    const wd = (b.ingestion_weight ?? 0) - (a.ingestion_weight ?? 0);
    if (wd !== 0) return wd;
    return (a.canonical_name ?? "").localeCompare(b.canonical_name ?? "");
  });
}

/**
 * Formats a flat array of joined rows into a Markdown catalog string.
 *
 * @param {Array<{
 *   canonical_name: string|null,
 *   kind: string|null,
 *   status: string,
 *   rss_url: string|null,
 *   social_profile_url: string|null,
 *   manifest_feed_id: string|null,
 *   ingestion_weight: number|null,
 *   active: boolean|null,
 *   updated_at: string|null,
 *   created_at: string|null,
 * }>} rows
 * @param {{ generatedAt: Date, supabaseUrl: string }} meta
 * @returns {string}
 */
export function formatCatalogMarkdown(rows, meta) {
  const sorted = sortRows(rows);

  const grouped = Object.fromEntries(STATUS_ORDER.map((s) => [s, []]));
  for (const row of sorted) {
    const bucket = STATUS_ORDER.includes(row.status) ? row.status : "pending";
    grouped[bucket].push(row);
  }

  const generatedAt = meta.generatedAt.toISOString();

  const lines = [
    `<!-- DO NOT EDIT — generated file. Run \`cd 05-engineering && npm run source-catalog:generate\` to regenerate. -->`,
    ``,
    `# Source Registry Catalog`,
    ``,
    `> **DO NOT EDIT** — this file is a generated read-only artifact.`,
    `> Supabase is the canonical source of truth for all source mappings.`,
    `> To update a mapping, edit the record in Supabase, then regenerate this file.`,
    `>`,
    `> **Generated:** ${generatedAt}`,
    `> **Supabase project:** ${meta.supabaseUrl}`,
    `> **Regenerate:** \`cd 05-engineering && npm run source-catalog:generate\``,
    ``,
    `## Summary`,
    ``,
    `| Metric | Count |`,
    `| ------ | ----- |`,
    `| Total | ${rows.length} |`,
    ...STATUS_ORDER.map((s) => `| ${capitalize(s)} | ${grouped[s].length} |`),
    ``,
  ];

  for (const status of STATUS_ORDER) {
    const section = grouped[status];
    lines.push(`## ${capitalize(status)}`);
    lines.push(``);
    if (section.length === 0) {
      lines.push(`_No entries._`);
    } else {
      lines.push(TABLE_HEADER);
      for (const row of section) lines.push(tableRow(row));
    }
    lines.push(``);
  }

  return lines.join("\n");
}

async function run() {
  const supabaseUrl = requireEnv("SUPABASE_URL");
  const supabaseKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

  const client = createClient(supabaseUrl, supabaseKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data, error } = await client
    .from("source_feed_mapping")
    .select(
      `manifest_feed_id,
       rss_url,
       social_profile_url,
       ingestion_weight,
       active,
       status,
       created_at,
       updated_at,
       source_entities ( canonical_name, kind )`
    );

  if (error) throw new Error(`Query failed: ${error.message}`);

  const rows = (data ?? []).map((row) => ({
    canonical_name: row.source_entities?.canonical_name ?? null,
    kind: row.source_entities?.kind ?? null,
    status: row.status,
    rss_url: row.rss_url ?? null,
    social_profile_url: row.social_profile_url ?? null,
    manifest_feed_id: row.manifest_feed_id ?? null,
    ingestion_weight: row.ingestion_weight ?? null,
    active: row.active ?? null,
    updated_at: row.updated_at ?? null,
    created_at: row.created_at ?? null,
  }));

  const markdown = formatCatalogMarkdown(rows, {
    generatedAt: new Date(),
    supabaseUrl,
  });

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const outPath = resolve(__dirname, "../../../../SOURCE-REGISTRY-CATALOG.generated.md");
  writeFileSync(outPath, markdown, "utf8");
  console.log(`[source-catalog] Wrote ${rows.length} rows → ${outPath}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().catch((err) => {
    console.error(`[source-catalog] Fatal: ${err.message}`);
    process.exit(1);
  });
}
