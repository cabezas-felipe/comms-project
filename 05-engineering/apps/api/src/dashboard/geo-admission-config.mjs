// Geo admission mode configuration.
//
// Why this module exists:
//   The dashboard refresh pipeline currently gates candidate items through a
//   hard geo-admission funnel (lane-1 / lane-2 split, cold_start defer, hold
//   bucket, Haiku geo assessor). Items without a lexical geo signal can be
//   deferred before clustering ever sees them — e.g. a Semana election article
//   that mentions "elecciones" but not "Colombia". The long-term fix is "soft"
//   geo: geography influences beat-fit / tags / diagnostics but never blocks
//   admission.
//
//   Soft is now the production DEFAULT (Prompt 4): geography no longer gates
//   admission unless an operator explicitly opts back into the old funnel with
//   `TEMPO_GEO_ADMISSION_MODE=hard`. The toggle is the rollback path — set it
//   to `hard` to restore the lane-1/lane-2 + cold_start defer + hold + Haiku
//   assessor behavior instantly, no deploy required. This module owns the env
//   resolution and the diagnostics shape; the runtime branch lives in
//   [`refresh-pipeline.mjs`](./refresh-pipeline.mjs).
//
// Style mirrors `resolveRecallConfig()` in
// [`../ingestion/embedding-recall.mjs`](../ingestion/embedding-recall.mjs):
//   trim + lowercase the raw env value, fail closed to the safe default on
//   anything unrecognized, and accept an injectable `env` + `override` so tests
//   and route handlers don't have to mutate `process.env`.

export const GEO_ADMISSION_MODES = Object.freeze({
  HARD: "hard",
  SOFT: "soft",
});

/**
 * Resolve the geo admission mode from env at call time (not import time) so
 * route handlers and tests can mutate `process.env` between runs.
 *
 * Precedence: explicit `override` (a valid mode) wins; otherwise read
 * `TEMPO_GEO_ADMISSION_MODE`. Unset / empty / unrecognized values resolve to
 * `soft` — the production default (Prompt 4). Only the explicit, exact value
 * `hard` restores the old admission funnel, so a typo never silently
 * re-enables the gate that was dropping election headlines.
 *
 * @param {object}   [opts]
 * @param {object}   [opts.env]      — env source (defaults to `process.env`).
 * @param {string}   [opts.override] — explicit mode; ignored unless it is a
 *                                      recognized `GEO_ADMISSION_MODES` value.
 * @returns {"hard" | "soft"}
 */
export function resolveGeoAdmissionMode({ env = process.env, override } = {}) {
  if (override === GEO_ADMISSION_MODES.HARD || override === GEO_ADMISSION_MODES.SOFT) {
    return override;
  }
  const raw = String(env.TEMPO_GEO_ADMISSION_MODE ?? "soft").trim().toLowerCase();
  if (raw === GEO_ADMISSION_MODES.HARD) return GEO_ADMISSION_MODES.HARD;
  if (raw === GEO_ADMISSION_MODES.SOFT || raw === "") return GEO_ADMISSION_MODES.SOFT;
  // Invalid value → resolve to the default (soft). Warn so a misconfigured env
  // is visible in logs without re-enabling the gate by accident.
  console.warn(
    `[pipeline.geo] unrecognized TEMPO_GEO_ADMISSION_MODE="${raw}" — falling back to "${GEO_ADMISSION_MODES.SOFT}"`
  );
  return GEO_ADMISSION_MODES.SOFT;
}

/**
 * Build the diagnostics fields surfaced on `log.geo` / `log.outcomes` →
 * `_meta.outcomes`. `geoAdmissionBypassed` reflects runtime behavior as
 * determined by the resolved mode (`soft` bypasses the gate, `hard` runs it).
 *
 * @param {"hard" | "soft"} mode
 * @returns {{ geoAdmissionMode: string, geoAdmissionBypassed: boolean }}
 */
export function geoAdmissionDiagnostics(mode) {
  return {
    geoAdmissionMode: mode,
    geoAdmissionBypassed: mode === GEO_ADMISSION_MODES.SOFT,
  };
}
