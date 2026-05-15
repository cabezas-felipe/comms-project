/**
 * Cluster Shape Smoke — CLI runner (Chunk M8)
 *
 * Thin CLI wrapper around `runClusterSmoke` in `cluster-smoke-core.mjs`.
 * All reusable logic lives in the core module; this file only handles:
 *   - loading apps/api/.env
 *   - resolving the clustering model from env
 *   - formatting human-readable PASS/FAIL output
 *   - mapping the structured result to an exit code
 *
 * Side effects (dotenv, console, process.exit) only fire when this file is
 * executed directly — they are gated behind a `process.argv[1]` check so an
 * accidental import (from a test, for example) is a no-op.
 *
 * Usage
 *   cd 05-engineering/apps/api && npm run eval:cluster-smoke
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import dotenv from "dotenv";
import { clusterItems } from "../cluster-engine.mjs";
import { getAiCapabilityMap, providerFor } from "../model-router.mjs";
import { runClusterSmoke } from "./cluster-smoke-core.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  // Load apps/api/.env by absolute path so the smoke works regardless of CWD.
  // Loading inside main() (not at module top level) keeps the import surface
  // env-mutation-free.
  dotenv.config({ path: path.resolve(__dirname, "..", "..", "..", ".env") });

  const model = getAiCapabilityMap().clustering;
  const provider = providerFor(model);
  const mockOnly = process.env.TEMPO_AI_MOCK_ONLY === "true";

  const HR = "─".repeat(60);
  console.log(`\n[cluster-smoke] model=${model} provider=${provider} mockOnly=${mockOnly}`);
  console.log(HR);

  const { ok, stories, failures, error } = await runClusterSmoke({
    clusterFn: clusterItems,
    model,
  });

  if (error) {
    console.error(`[cluster-smoke] FAIL — clusterItems threw: ${error.message}`);
    process.exit(1);
  }

  if (!ok) {
    console.error(`[cluster-smoke] FAIL — ${failures.length} contract violation(s):`);
    for (const reason of failures) console.error(`  • ${reason}`);
    console.error(`\n[cluster-smoke] received ${stories.length} meta-stories:`);
    console.error(JSON.stringify(stories, null, 2));
    process.exit(1);
  }

  console.log(
    `[cluster-smoke] PASS — ${stories.length} meta-stor${stories.length === 1 ? "y" : "ies"} validated against metaStoryOutputSchema`
  );
  for (const story of stories) {
    console.log(
      `  • meta_story_id=${story.meta_story_id} title="${story.title}" sources=[${story.source_item_ids.join(", ")}]`
    );
  }
  console.log("");
}

// Direct-execution guard.  Mirrors the pattern used by server.mjs — main()
// fires only when this file is the node entrypoint, never on import.
if (process.argv[1] === __filename) {
  main().catch((err) => {
    console.error("[cluster-smoke] Fatal error:", err);
    process.exit(1);
  });
}
