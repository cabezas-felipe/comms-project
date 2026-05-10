#!/usr/bin/env node
// Apply unrecorded SQL migrations from src/db/migrations/ in lexical order.
// Each file runs in its own transaction; success is recorded in
// public.schema_migrations so reruns are no-ops.
//
// Usage: DATABASE_URL=postgresql://... npm run db:migrate
//        npm run db:migrate -- --dry-run     (lists pending, applies nothing)
//        npm run db:migrate -- --mark-applied=001_initial.sql,002_user_settings.sql
//                                              (insert ledger rows without running SQL —
//                                               for backfilling already-applied migrations)

import dotenv from "dotenv";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ENV_PATH = path.resolve(__dirname, "..", ".env");
const MIGRATIONS_DIR = path.resolve(__dirname, "..", "src", "db", "migrations");

dotenv.config({ path: ENV_PATH });

const argv = process.argv.slice(2);
const args = new Set(argv);
const DRY_RUN = args.has("--dry-run");
const markFlag = argv.find((a) => a.startsWith("--mark-applied="));
const MARK_APPLIED = markFlag
  ? markFlag.replace("--mark-applied=", "").split(",").map((s) => s.trim()).filter(Boolean)
  : [];

if (!process.env.DATABASE_URL) {
  console.error(
    "[db:migrate] DATABASE_URL is not set.\n" +
      "Add it to apps/api/.env. Get the connection string from\n" +
      "  Supabase Dashboard → Project Settings → Database → Connection string (URI).\n" +
      "Use the pooler (port 6543) for shared/CI runs, or the direct connection (port 5432)\n" +
      "from a single trusted machine."
  );
  process.exit(1);
}

const SSL_REQUIRED = /supabase\.(co|com)/i.test(process.env.DATABASE_URL);

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: SSL_REQUIRED ? { rejectUnauthorized: false } : undefined,
});

async function ensureLedger() {
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      filename     TEXT PRIMARY KEY,
      applied_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function appliedSet() {
  const { rows } = await client.query(
    "SELECT filename FROM public.schema_migrations"
  );
  return new Set(rows.map((r) => r.filename));
}

async function listMigrationFiles() {
  const entries = await fs.readdir(MIGRATIONS_DIR);
  return entries
    .filter((f) => f.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
}

async function applyOne(filename) {
  const full = path.join(MIGRATIONS_DIR, filename);
  const sql = await fs.readFile(full, "utf8");
  console.log(`→ applying ${filename}`);
  await client.query("BEGIN");
  try {
    await client.query(sql);
    await client.query(
      "INSERT INTO public.schema_migrations (filename) VALUES ($1)",
      [filename]
    );
    await client.query("COMMIT");
    console.log(`✔ applied  ${filename}`);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(`✘ failed   ${filename}`);
    throw err;
  }
}

async function main() {
  await client.connect();
  try {
    await ensureLedger();

    if (MARK_APPLIED.length > 0) {
      const fileSet = new Set(await listMigrationFiles());
      const unknown = MARK_APPLIED.filter((f) => !fileSet.has(f));
      if (unknown.length > 0) {
        throw new Error(
          `--mark-applied references files not in migrations dir: ${unknown.join(", ")}`
        );
      }
      console.log(`[db:migrate] backfilling ledger for ${MARK_APPLIED.length} file(s):`);
      for (const f of MARK_APPLIED) {
        console.log(`  - ${f}`);
        await client.query(
          "INSERT INTO public.schema_migrations (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING",
          [f]
        );
      }
      console.log("[db:migrate] backfill complete.");
      return;
    }

    const [files, applied] = await Promise.all([
      listMigrationFiles(),
      appliedSet(),
    ]);
    const pending = files.filter((f) => !applied.has(f));

    if (pending.length === 0) {
      console.log(`[db:migrate] up to date (${applied.size} applied, 0 pending)`);
      return;
    }

    console.log(
      `[db:migrate] ${applied.size} applied, ${pending.length} pending:`
    );
    for (const f of pending) console.log(`  - ${f}`);

    if (DRY_RUN) {
      console.log("[db:migrate] --dry-run: no changes made.");
      return;
    }

    for (const f of pending) {
      await applyOne(f);
    }
    console.log(`[db:migrate] done. applied ${pending.length} migration(s).`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("[db:migrate] FATAL:", err.message);
  if (err.detail) console.error("  detail:", err.detail);
  if (err.hint) console.error("  hint:  ", err.hint);
  process.exitCode = 1;
});
