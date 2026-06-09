/**
 * Dashboard Live-Cluster Advisory — CLI runner (Q6D)
 *
 * ADVISORY / NON-BLOCKING. This is the ONLY dashboard eval that makes a real,
 * provider-backed clustering call. It exercises the live cluster prompt
 * (`cluster-v4`) + model against a stable election fixture subset to detect
 * PROMPT / MODEL DRIFT in the cluster output shape — most importantly that the
 * B1 grounded tags (`tags.geographies`) and `associated_entities` keep showing
 * up. It is deliberately NOT wired into `eval:dashboard-quality-gate` and never
 * gates a PR merge; a scheduled job runs it to alert owners when live output
 * drifts.
 *
 * Skip-safe:
 *   - When the cluster model routes to a mock provider, `TEMPO_AI_MOCK_ONLY=true`,
 *     or the required provider key is absent, the runner prints a clear
 *     `SKIPPED` reason and exits 0 (nothing live to drift-check — never a CI
 *     failure for missing local keys).
 *
 * Exit code:
 *   0  — SKIPPED (no live provider) OR ran and all advisory checks held
 *   1  — ran and an advisory check failed (or the live clustering call errored)
 *        — a scheduled job treats this as "alert the owners", not "block merge"
 *
 * Usage
 *   cd 05-engineering/apps/api && npm run eval:dashboard-live-cluster-advisory
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

import { providerFor } from "../model-router.mjs";
import { clusterItems } from "../cluster-engine.mjs";
import {
  COLOMBIA_ELECTION_ITEMS,
  ELECTIONS_COLOMBIA_PERSONA,
} from "./dashboard-elections-colombia-core.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load apps/api/.env by absolute path so keys/config are available regardless of
// CWD. dotenv.config() is a no-op when the file is absent, so this is safe.
dotenv.config({ path: path.resolve(__dirname, "..", "..", "..", ".env") });

// Mock by default: with no configured live model the runner SKIPS rather than
// silently exercising the deterministic mock path (which can't drift).
const DEFAULT_CLUSTER_MODEL = "mock-anthropic-haiku";

const HR = "─".repeat(72);

/**
 * Decide whether a live, drift-checkable clustering run is possible. Mirrors the
 * provider/key resolution `clusterItems` itself uses, so "runnable" here means
 * the same call will actually hit a provider rather than the mock branch.
 */
function resolveLiveClusterContext() {
  const model = (process.env.TEMPO_AI_CLUSTER_MODEL || DEFAULT_CLUSTER_MODEL).trim();

  if (process.env.TEMPO_AI_MOCK_ONLY === "true") {
    return {
      runnable: false,
      model,
      reason: "TEMPO_AI_MOCK_ONLY=true — clustering is forced to the deterministic mock path (nothing live to drift-check)",
    };
  }

  const provider = providerFor(model);

  if (provider === "anthropic") {
    const key = process.env.TEMPO_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
    if (!key) {
      return {
        runnable: false,
        model,
        provider,
        reason: `cluster model "${model}" needs an Anthropic key, but TEMPO_ANTHROPIC_API_KEY / ANTHROPIC_API_KEY is not set`,
      };
    }
    return { runnable: true, model, provider };
  }

  if (provider === "openai-compatible") {
    const key = process.env.TEMPO_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
    if (!key) {
      return {
        runnable: false,
        model,
        provider,
        reason: `cluster model "${model}" needs an OpenAI key, but TEMPO_OPENAI_API_KEY / OPENAI_API_KEY is not set`,
      };
    }
    return { runnable: true, model, provider };
  }

  // mock-anthropic / mock-openai
  return {
    runnable: false,
    model,
    provider,
    reason: `cluster model "${model}" routes to a mock provider (${provider}) — set TEMPO_AI_CLUSTER_MODEL to a live "anthropic:" / "openai:" model to drift-check`,
  };
}

function nonEmptyArray(v) {
  return Array.isArray(v) && v.length > 0;
}

/**
 * Evaluate the live clustering output against SOFT (advisory) expectations.
 * Returns `{ checks: [{id, ok, detail}], pass }`. Thresholds are deliberately
 * lenient (coverage ratios, not per-story strictness) so normal model variance
 * doesn't page owners — only a real drift (e.g. entities stop appearing, or the
 * model atomizes every source into its own story) trips a check.
 */
function evaluateAdvisory(stories) {
  const checks = [];
  const add = (id, ok, detail) => checks.push({ id, ok, detail });

  const total = stories.length;
  const inputCount = COLOMBIA_ELECTION_ITEMS.length;

  // 1. Story count in a sane range — neither collapsed to nothing nor atomized
  //    past the locked 5-story cap.
  add(
    "story-count-sane",
    total >= 1 && total <= 5,
    `clustered ${inputCount} election items into ${total} meta-stories (sane range: 1–5)`
  );

  // 2. Not atomized chaos — at least one meta-story merged ≥2 sources.
  const maxSources = stories.reduce(
    (m, s) => Math.max(m, Array.isArray(s.source_item_ids) ? s.source_item_ids.length : 0),
    0
  );
  add(
    "merging-happened",
    maxSources >= 2,
    `largest meta-story has ${maxSources} sources (expected ≥2 — same-cycle election coverage should bundle, not atomize)`
  );

  // 3. tags.geographies present on most stories (B1 grounded tags).
  const withGeo = stories.filter((s) => nonEmptyArray(s?.tags?.geographies)).length;
  const geoCoverage = total > 0 ? withGeo / total : 0;
  add(
    "tags-geographies-present",
    geoCoverage >= 0.5,
    `${withGeo}/${total} stories carry tags.geographies (coverage ${(geoCoverage * 100).toFixed(0)}%, advisory floor 50%)`
  );

  // 4. associated_entities present (B1 entity-fit drift signal). cluster-v4
  //    instructs the model to emit grounded entities; if they stop appearing the
  //    prompt/model has drifted.
  const withEntities = stories.filter((s) => nonEmptyArray(s?.associated_entities)).length;
  const entityCoverage = total > 0 ? withEntities / total : 0;
  add(
    "associated-entities-present",
    entityCoverage >= 0.5,
    `${withEntities}/${total} stories carry associated_entities (coverage ${(entityCoverage * 100).toFixed(0)}%, advisory floor 50%)`
  );

  return { checks, pass: checks.every((c) => c.ok) };
}

async function main() {
  console.log("\n[live-cluster-advisory] Dashboard live cluster monitor (ADVISORY / non-blocking)");
  console.log(HR);

  const ctx = resolveLiveClusterContext();
  if (!ctx.runnable) {
    console.log(`[live-cluster-advisory] SKIPPED — ${ctx.reason}`);
    console.log("[live-cluster-advisory] (advisory: a missing local key is never a failure) → exit 0\n");
    process.exit(0);
  }

  console.log(`[live-cluster-advisory] live run — model=${ctx.model} provider=${ctx.provider}`);
  console.log(`[live-cluster-advisory] clustering ${COLOMBIA_ELECTION_ITEMS.length} Colombia-election fixtures …`);

  let stories;
  try {
    stories = await clusterItems(
      COLOMBIA_ELECTION_ITEMS.map((i) => ({ ...i })),
      ELECTIONS_COLOMBIA_PERSONA,
      ctx.model
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[live-cluster-advisory] FAIL — live clustering call errored: ${msg}`);
    console.error("[live-cluster-advisory] (advisory: alert owners — the live cluster path is broken or drifted) → exit 1\n");
    process.exit(1);
  }

  const { checks, pass } = evaluateAdvisory(stories ?? []);
  console.log(HR);
  for (const c of checks) {
    console.log(`    ${c.ok ? "✓" : "✗"} ${c.id} — ${c.detail}`);
  }
  console.log(HR);

  if (!pass) {
    console.error("[live-cluster-advisory] FAIL — one or more advisory checks did not hold (possible prompt/model drift).");
    console.error("[live-cluster-advisory] (advisory: alert owners; this does NOT gate PR merge) → exit 1\n");
    process.exit(1);
  }
  console.log("[live-cluster-advisory] OK — live cluster output looks healthy (advisory checks held).\n");
}

// Direct-execution guard — main() fires only when this file is the entrypoint.
if (process.argv[1] === __filename) {
  main().catch((err) => {
    console.error("[live-cluster-advisory] Fatal error:", err);
    // A runner crash is infra, not a drift signal — still exit 1 so a scheduled
    // job notices, but the message distinguishes it from an advisory check fail.
    process.exit(1);
  });
}

export { resolveLiveClusterContext, evaluateAdvisory };
