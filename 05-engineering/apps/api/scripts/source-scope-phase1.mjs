#!/usr/bin/env node
// Phase-1 source scope (Washington Post only).
//
// This script is the explicit, operator-driven control for the Supabase
// manifest's `active` flag. The runtime ingestion guard in feed-reader.mjs
// (TEMPO_RSS_ALLOWLIST — legacy alias TEMPO_INGESTION_ALLOWLIST — defaults
// to "washington post") provides defense-in-depth; this script is the
// *primary* lever.
//
// Modes (one per invocation):
//   apply    — disable every non-WaPo manifest row that is currently active,
//              recording each disable in `phase1_disabled_feeds` so restore
//              can flip exactly those rows back. Idempotent: re-running on a
//              fully applied state is a no-op.
//   restore  — re-enable ONLY rows previously disabled by this script (read
//              from the tracker), then delete the tracker entries. Rows that
//              were already inactive for unrelated reasons are NEVER touched.
//   verify   — read-only: print every manifest row + tracker contents + the
//              phase-1 invariant ("only WaPo rows are active").
//
// Flags:
//   --dry-run   Show what would change without writing anything.
//   --json      Emit machine-readable JSON instead of human output (verify only).
//
// Recovery from accidental drift: `verify` first, then `apply` (idempotent).

import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Detect "run as script" vs "imported by tests" so the file is safe to import
// without auto-connecting to the database. Only the script entry path triggers
// dotenv loading + pg client construction + dispatch.
const isEntryPoint =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

// ─── argv parsing ────────────────────────────────────────────────────────────

const VALID_MODES = new Set(["apply", "restore", "verify"]);

/**
 * Pure parser exported for unit tests. Takes raw argv (without the node/script
 * prefix), returns either `{ ok: true, mode, dryRun, jsonOut }` or
 * `{ ok: false, error }`. Defaults: mode="apply", dryRun=false, jsonOut=false.
 *
 * Back-compat: an old call site may still pass `--restore` as a flag rather
 * than a positional. Support that explicitly so muscle memory doesn't break.
 */
export function parseArgs(argv) {
  const dryRun = argv.includes("--dry-run");
  const jsonOut = argv.includes("--json");
  const positional = argv.filter((a) => !a.startsWith("--"));
  let mode = positional[0];
  if (!mode && argv.includes("--restore")) mode = "restore";
  if (!mode) mode = "apply";
  if (!VALID_MODES.has(mode)) {
    return { ok: false, error: `Unknown mode '${mode}'. Use one of: ${[...VALID_MODES].join(", ")}.` };
  }
  return { ok: true, mode, dryRun, jsonOut };
}

// ─── WaPo matcher (robust, normalization-based) ──────────────────────────────
//
// Previous strict ILIKE 'The Washington Post%' / regex /^the washington post/i
// was brittle to naming variations: "Washington Post — World" (no "The"),
// "Washington Post-Politics" (different punctuation), leading whitespace, etc.
// This normalize-then-substring approach accepts any canonical that, after
// dropping a leading "The" and collapsing punctuation/whitespace, contains
// "washington post" as a contiguous token sequence.

const WAPO_NEEDLE = "washington post";

/**
 * Lowercase, drop a leading "the ", replace punctuation with spaces, collapse
 * whitespace. Mirrors the convention used by source-matcher.normalizeForMatching.
 * Pure / exported for tests.
 */
export function normalizeForWaPoCheck(s) {
  if (s == null) return "";
  return String(s)
    .toLowerCase()
    .replace(/^\s*the\s+/i, "")
    .replace(/[—–\-_/.,:;()'"!?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * True when the canonical name represents a Washington Post entity, regardless
 * of the "The " prefix and minor punctuation/spacing variants. Pure / exported.
 */
export function isWashingtonPost(canonicalName) {
  return normalizeForWaPoCheck(canonicalName).includes(WAPO_NEEDLE);
}

// ─── Restore planner (pure) ──────────────────────────────────────────────────

/**
 * Pure planner used by `runRestore`. Given the tracker rows and a map of
 * {manifest_feed_id -> rowCount} representing the result of the UPDATE
 * issued for each tracked feed, classify each tracker entry as either
 * "resolved" (the manifest row was found and updated, tracker entry should
 * be deleted) or "unresolved" (no manifest row matched, so the tracker
 * entry must be PRESERVED so a later restore can retry).
 *
 * This separation keeps the safety contract testable without a live DB.
 */
export function planRestoreActions(tracked, updateRowCountById) {
  const resolved = [];
  const unresolved = [];
  for (const t of tracked ?? []) {
    const rowCount = updateRowCountById?.get?.(t.manifest_feed_id) ?? 0;
    if (rowCount > 0) resolved.push(t);
    else unresolved.push(t);
  }
  return { resolved, unresolved };
}

// Module-level state assigned only at script entry. Tests import this file to
// exercise pure helpers (parseArgs); they MUST NOT trigger DB connect.
let mode;
let DRY_RUN = false;
let JSON_OUT = false;
let c = null;

if (isEntryPoint) {
  dotenv.config({ path: path.resolve(__dirname, "..", ".env") });
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(parsed.error);
    console.error(`Usage: node source-scope-phase1.mjs <apply|restore|verify> [--dry-run] [--json]`);
    process.exit(2);
  }
  ({ mode, dryRun: DRY_RUN, jsonOut: JSON_OUT } = parsed);

  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set. Add it to apps/api/.env (see README.md).");
    process.exit(1);
  }

  c = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();
}

// ─── Tracker table (script-internal; auto-created on first run) ──────────────
//
// Stored OUTSIDE schema_migrations because this is operational state, not a
// schema-evolution event. One row per feed disabled by *this script*. Restore
// reads only these rows and deletes them after flipping `active` back.

async function ensureTracker() {
  await c.query(`
    CREATE TABLE IF NOT EXISTS public.phase1_disabled_feeds (
      manifest_feed_id  TEXT        PRIMARY KEY,
      canonical_name    TEXT,
      prev_active       BOOLEAN     NOT NULL,
      disabled_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      disabled_by       TEXT        NOT NULL DEFAULT 'source-scope-phase1.mjs'
    )
  `);
}

// ─── Mode: verify ────────────────────────────────────────────────────────────

async function runVerify() {
  await ensureTracker();
  const rows = (await c.query(`
    SELECT m.manifest_feed_id,
           m.active,
           m.status,
           e.canonical_name
      FROM public.source_feed_mapping m
      LEFT JOIN public.source_entities e ON e.id = m.source_entity_id
     ORDER BY e.canonical_name NULLS LAST, m.manifest_feed_id
  `)).rows;

  const tracker = (await c.query(`
    SELECT manifest_feed_id, canonical_name, prev_active, disabled_at, disabled_by
      FROM public.phase1_disabled_feeds
     ORDER BY canonical_name NULLS LAST, manifest_feed_id
  `)).rows;

  const wapoActive = rows.filter((r) => r.active && isWashingtonPost(r.canonical_name)).length;
  const nonWapoActive = rows.filter((r) => r.active && !isWashingtonPost(r.canonical_name));
  const invariantHolds = nonWapoActive.length === 0;

  if (JSON_OUT) {
    process.stdout.write(JSON.stringify({
      rows,
      tracker,
      wapoActive,
      nonWapoActive: nonWapoActive.map((r) => ({ id: r.manifest_feed_id, name: r.canonical_name })),
      invariantHolds,
    }, null, 2) + "\n");
    return;
  }

  console.log(`source_feed_mapping rows (n=${rows.length}):\n`);
  console.log("  active  status      canonical_name                                  manifest_feed_id");
  console.log("  ──────  ──────────  ──────────────────────────────────────────────  ────────────────────");
  for (const r of rows) {
    const a = r.active ? "true   " : "false  ";
    const name = (r.canonical_name ?? "?").padEnd(46);
    console.log(`  ${a} ${(r.status ?? "?").padEnd(10)}  ${name}  ${r.manifest_feed_id ?? "?"}`);
  }
  console.log("");
  console.log(`phase1_disabled_feeds tracker (n=${tracker.length}):`);
  if (tracker.length === 0) {
    console.log("  (empty — nothing recorded by this script)");
  } else {
    for (const t of tracker) {
      const ts = t.disabled_at instanceof Date ? t.disabled_at.toISOString() : t.disabled_at;
      console.log(`  - ${t.manifest_feed_id}  ${t.canonical_name ?? "?"}  prev_active=${t.prev_active}  at=${ts}`);
    }
  }
  console.log("");
  console.log(`WaPo rows active:     ${wapoActive}`);
  console.log(`Non-WaPo rows active: ${nonWapoActive.length}`);
  if (invariantHolds) {
    console.log("✔ Phase-1 invariant holds: only Washington Post rows are active.");
  } else {
    console.log("✘ Phase-1 invariant VIOLATED — non-WaPo rows still active:");
    for (const r of nonWapoActive) {
      console.log(`    - ${r.canonical_name ?? "?"} (${r.manifest_feed_id ?? "?"})`);
    }
    process.exitCode = 1;
  }
}

// ─── Mode: apply ─────────────────────────────────────────────────────────────

async function runApply() {
  await ensureTracker();

  // Pull every active manifest row + the tracker, then classify in JS using
  // the robust `isWashingtonPost` helper. The previous SQL `NOT ILIKE
  // 'The Washington Post%'` was brittle to "Washington Post — Foo" or other
  // canonical variants. Doing the classification in JS keeps a single source
  // of truth for the WaPo predicate (also used by verify).
  const all = (await c.query(`
    SELECT m.manifest_feed_id,
           m.active,
           e.canonical_name,
           t.manifest_feed_id AS tracked
      FROM public.source_feed_mapping m
      LEFT JOIN public.source_entities e ON e.id = m.source_entity_id
      LEFT JOIN public.phase1_disabled_feeds t ON t.manifest_feed_id = m.manifest_feed_id
     ORDER BY e.canonical_name NULLS LAST, m.manifest_feed_id
  `)).rows;

  const targets = all.filter(
    (r) => r.active === true && r.tracked === null && !isWashingtonPost(r.canonical_name)
  );

  if (targets.length === 0) {
    console.log("apply: nothing to do (all non-WaPo active rows already recorded + disabled).");
  } else {
    console.log(`apply${DRY_RUN ? " (dry-run)" : ""}: ${targets.length} non-WaPo active row(s) to disable:`);
    for (const t of targets) {
      console.log(`  - ${t.canonical_name ?? "?"} (${t.manifest_feed_id ?? "?"})  prev_active=${t.active}`);
    }
  }

  if (!DRY_RUN && targets.length > 0) {
    await c.query("BEGIN");
    try {
      for (const t of targets) {
        await c.query(
          `INSERT INTO public.phase1_disabled_feeds
              (manifest_feed_id, canonical_name, prev_active)
           VALUES ($1, $2, $3)
           ON CONFLICT (manifest_feed_id) DO NOTHING`,
          [t.manifest_feed_id, t.canonical_name, t.active]
        );
        await c.query(
          `UPDATE public.source_feed_mapping
              SET active = false
            WHERE manifest_feed_id = $1`,
          [t.manifest_feed_id]
        );
      }
      await c.query("COMMIT");
      console.log(`apply: disabled ${targets.length} row(s); recorded in phase1_disabled_feeds.`);
    } catch (err) {
      await c.query("ROLLBACK");
      throw err;
    }
  }

  // Sanity post-condition (safe even on dry-run). Re-query and classify in JS.
  const wapoActive = all.filter(
    (r) => isWashingtonPost(r.canonical_name) && (r.active === true ||
      // After a real apply, `all` is stale for rows we just modified — but apply
      // never touches WaPo rows, so this count remains accurate without a re-query.
      false)
  ).length;
  console.log(`WaPo active feeds: ${wapoActive}`);
}

// ─── Mode: restore ───────────────────────────────────────────────────────────

async function runRestore() {
  await ensureTracker();

  const tracked = (await c.query(`
    SELECT t.manifest_feed_id,
           t.canonical_name,
           t.prev_active,
           m.active AS current_active,
           (m.manifest_feed_id IS NOT NULL) AS row_exists
      FROM public.phase1_disabled_feeds t
      LEFT JOIN public.source_feed_mapping m ON m.manifest_feed_id = t.manifest_feed_id
     ORDER BY t.canonical_name NULLS LAST, t.manifest_feed_id
  `)).rows;

  if (tracked.length === 0) {
    console.log("restore: nothing to do (tracker is empty).");
    return;
  }

  console.log(`restore${DRY_RUN ? " (dry-run)" : ""}: ${tracked.length} row(s) recorded in tracker:`);
  for (const t of tracked) {
    let note = "";
    if (!t.row_exists) {
      note = " (manifest row missing — tracker entry will be PRESERVED for retry)";
    } else if (t.current_active === t.prev_active) {
      note = " (already at prev_active — would only delete tracker row)";
    }
    console.log(`  - ${t.canonical_name ?? "?"} (${t.manifest_feed_id})  prev_active=${t.prev_active}  current_active=${t.current_active}${note}`);
  }

  if (DRY_RUN) return;

  // Per-row UPDATE with safety: DELETE the tracker entry only when the UPDATE
  // actually flipped a row (rowCount > 0). Missing manifest rows preserve
  // their tracker entry so a future restore can retry once the row reappears.
  // The whole batch is a single transaction so a mid-loop pg error rolls
  // back any partial writes.
  const updateRowCountById = new Map();

  await c.query("BEGIN");
  try {
    for (const t of tracked) {
      const r = await c.query(
        `UPDATE public.source_feed_mapping
            SET active = $2
          WHERE manifest_feed_id = $1`,
        [t.manifest_feed_id, t.prev_active]
      );
      updateRowCountById.set(t.manifest_feed_id, r.rowCount);
      if (r.rowCount > 0) {
        await c.query(
          `DELETE FROM public.phase1_disabled_feeds WHERE manifest_feed_id = $1`,
          [t.manifest_feed_id]
        );
      }
    }
    await c.query("COMMIT");
  } catch (err) {
    await c.query("ROLLBACK");
    throw err;
  }

  const { resolved, unresolved } = planRestoreActions(tracked, updateRowCountById);
  console.log(
    `restore: applied prev_active to ${resolved.length} row(s); ` +
    `cleared ${resolved.length} tracker entr${resolved.length === 1 ? "y" : "ies"}.`
  );
  if (unresolved.length > 0) {
    console.warn(
      `restore: ${unresolved.length} tracker entr${unresolved.length === 1 ? "y" : "ies"} ` +
      `preserved (manifest rows missing — re-run restore after the row reappears):`
    );
    for (const u of unresolved) {
      console.warn(`  - ${u.canonical_name ?? "?"} (${u.manifest_feed_id})`);
    }
    // Non-zero exit code so CI / operator scripts notice unresolved state.
    process.exitCode = 3;
  }
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

if (isEntryPoint) {
  try {
    if (mode === "verify") await runVerify();
    else if (mode === "apply") await runApply();
    else if (mode === "restore") await runRestore();
  } finally {
    await c.end();
  }
}
