// Sub-slice 2.5: scheduled cadence-tick entrypoint.
//
// Internal-only — no HTTP surface, no user-facing API.  Invoked by the
// scheduled GitHub Action (or manually via `node apps/api/src/ops/cadence-tick.mjs`)
// to drive the 2.4 due-user orchestrator on a fixed cadence so users whose
// browser is closed still get refreshed at `REFRESH_INTERVAL_MS`.
//
// Wiring:
//   - Reuses `_dueUserOrchestrator.runDueRefreshes()` from server.mjs verbatim.
//     No due-selection or executor logic is reimplemented here.
//   - Server-side env (SUPABASE_URL + service-role key) is required so the
//     orchestrator can list anchors and the executor can read/write snapshots.
//
// Logs:
//   - Emits one JSON line tagged `[cadence-tick]` summarizing the run.  Cron
//     output is the inspection surface — `grep '\[cadence-tick\]'` in the
//     Action's log is enough to read summary fields without scrolling.
//
// Exit codes:
//   - 0  — orchestrator returned a summary (per-user errors are surfaced via
//          `summary.errors`/`summary.kinds`, NOT via a non-zero exit, so a
//          single bad user can't squelch the next scheduled tick).
//   - 1  — true orchestrator-level failure: required env missing, the anchor
//          list throws/errors before any user is considered, or the
//          orchestrator itself rejects.  These are the only cases where the
//          run produced no usable signal and re-trying sooner makes sense.

import "dotenv/config";
import { fileURLToPath } from "node:url";

/**
 * Runs one orchestrator tick and emits a structured summary log.
 *
 * Exposed for unit tests so the entrypoint contract (log shape + return code
 * semantics) can be asserted without spawning a real process or speaking to
 * Supabase.  Tests inject `runDueRefreshesFn` and `logger`; production reads
 * defaults that point at the real server hook.
 *
 * @param {object} [args]
 * @param {() => Promise<object>} [args.runDueRefreshesFn]
 * @param {(line: string) => void} [args.logger]
 * @param {() => string|undefined} [args.envGet] — abstracted so the env check
 *   stays testable without mutating real `process.env`
 * @returns {Promise<{ exitCode: number, summary: object|null, reason: string|null }>}
 */
export async function runCadenceTick({
  runDueRefreshesFn,
  logger = (line) => console.log(line),
  envGet = (name) => process.env[name],
} = {}) {
  const startedAt = new Date().toISOString();

  if (!envGet("SUPABASE_URL") || !envGet("SUPABASE_SERVICE_ROLE_KEY")) {
    const reason = "missing_supabase_env";
    logger(
      `[cadence-tick] ${JSON.stringify({
        startedAt,
        ok: false,
        skippedReason: reason,
        message:
          "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set for the orchestrator to list anchors.",
      })}`
    );
    return { exitCode: 1, summary: null, reason };
  }

  // Lazy-import server.mjs only when env is satisfied — keeps the unit test
  // for the env-missing branch cheap (no server boot, no .env side effects).
  let runFn = runDueRefreshesFn;
  if (typeof runFn !== "function") {
    const mod = await import("../server.mjs");
    runFn = (opts) => mod._dueUserOrchestrator.runDueRefreshes(opts);
  }

  let summary;
  try {
    summary = await runFn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger(
      `[cadence-tick] ${JSON.stringify({
        startedAt,
        ok: false,
        skippedReason: "orchestrator_threw",
        error: message,
      })}`
    );
    return { exitCode: 1, summary: null, reason: "orchestrator_threw" };
  }

  // `skippedReason` of "list_threw" or "list_error" means the orchestrator
  // never iterated any user — the run produced no signal.  Treated as a
  // true failure (exit 1) so cron retries are not silently masked.  Any
  // other value (including "none") is a successful tick: per-user errors
  // are already counted in `summary.errors` without aborting the loop.
  const orchestratorFailed =
    summary?.skippedReason === "list_threw" ||
    summary?.skippedReason === "list_error";

  logger(
    `[cadence-tick] ${JSON.stringify({
      startedAt,
      ok: !orchestratorFailed,
      candidates: summary?.candidates ?? 0,
      due: summary?.due ?? 0,
      ran: summary?.ran ?? 0,
      errors: summary?.errors ?? 0,
      kinds: summary?.kinds ?? {},
      skippedReason: summary?.skippedReason ?? "unknown",
      intervalMs: summary?.intervalMs,
      ...(summary?.error ? { error: summary.error } : {}),
    })}`
  );

  return {
    exitCode: orchestratorFailed ? 1 : 0,
    summary,
    reason: orchestratorFailed ? summary.skippedReason : null,
  };
}

// Direct-invocation guard mirrors the source-delta-digest pattern: only run
// `process.exit` when this file is the entrypoint, so tests can `import` the
// module without triggering the process exit.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCadenceTick()
    .then(({ exitCode }) => {
      process.exit(exitCode);
    })
    .catch((err) => {
      // Defensive net: runCadenceTick is supposed to catch all internal errors
      // and translate them into the structured log + exit-code contract.  If
      // it ever rejects, log + exit 1 so cron has a fingerprint to grep on.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[cadence-tick] Fatal (uncaught): ${message}`);
      process.exit(1);
    });
}
