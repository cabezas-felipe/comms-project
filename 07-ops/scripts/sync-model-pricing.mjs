#!/usr/bin/env node
/**
 * Copy 07-ops/model-pricing.json → API runtime path (Vercel root = apps/api).
 * Usage: node 07-ops/scripts/sync-model-pricing.mjs [--check]
 *   --check  exit 1 if runtime copy differs from ops SoT (CI)
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const src = join(root, "07-ops/model-pricing.json");
const destDir = join(root, "06-engineering/apps/api/src/ai/pricing");
const dest = join(destDir, "model-prices.json");
const checkOnly = process.argv.includes("--check");

const srcRaw = readFileSync(src, "utf8");
const srcNorm = `${JSON.stringify(JSON.parse(srcRaw), null, 2)}\n`;

if (checkOnly) {
  let destRaw;
  try {
    destRaw = readFileSync(dest, "utf8");
  } catch {
    console.error(`[sync-model-pricing] Missing runtime copy: ${dest}`);
    process.exit(1);
  }
  const destNorm = `${JSON.stringify(JSON.parse(destRaw), null, 2)}\n`;
  if (srcNorm !== destNorm) {
    console.error(
      "[sync-model-pricing] Drift: 07-ops/model-pricing.json ≠ apps/api/.../model-prices.json\n" +
        "Run: node 07-ops/scripts/sync-model-pricing.mjs"
    );
    process.exit(1);
  }
  console.log("[sync-model-pricing] OK — runtime copy matches ops SoT");
  process.exit(0);
}

mkdirSync(destDir, { recursive: true });
writeFileSync(dest, srcNorm, "utf8");
console.log(`[sync-model-pricing] Wrote ${dest}`);
