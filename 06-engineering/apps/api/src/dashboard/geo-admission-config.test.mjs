import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GEO_ADMISSION_MODES,
  resolveGeoAdmissionMode,
  geoAdmissionDiagnostics,
} from "./geo-admission-config.mjs";

// All cases inject `env` so we never mutate the real `process.env`.

test("resolveGeoAdmissionMode: unset env → soft (default, Prompt 4)", () => {
  assert.equal(resolveGeoAdmissionMode({ env: {} }), GEO_ADMISSION_MODES.SOFT);
});

test("resolveGeoAdmissionMode: explicit hard → hard (rollback path)", () => {
  assert.equal(
    resolveGeoAdmissionMode({ env: { TEMPO_GEO_ADMISSION_MODE: "hard" } }),
    GEO_ADMISSION_MODES.HARD
  );
});

test("resolveGeoAdmissionMode: HARD (uppercase) → hard", () => {
  assert.equal(
    resolveGeoAdmissionMode({ env: { TEMPO_GEO_ADMISSION_MODE: "HARD" } }),
    GEO_ADMISSION_MODES.HARD
  );
});

test("resolveGeoAdmissionMode: soft → soft", () => {
  assert.equal(
    resolveGeoAdmissionMode({ env: { TEMPO_GEO_ADMISSION_MODE: "soft" } }),
    GEO_ADMISSION_MODES.SOFT
  );
});

test("resolveGeoAdmissionMode: HARD with surrounding whitespace → hard", () => {
  assert.equal(
    resolveGeoAdmissionMode({ env: { TEMPO_GEO_ADMISSION_MODE: "  HARD  " } }),
    GEO_ADMISSION_MODES.HARD
  );
});

test("resolveGeoAdmissionMode: empty string → soft (default)", () => {
  assert.equal(
    resolveGeoAdmissionMode({ env: { TEMPO_GEO_ADMISSION_MODE: "   " } }),
    GEO_ADMISSION_MODES.SOFT
  );
});

test("resolveGeoAdmissionMode: invalid value → soft (default; only exact 'hard' rolls back)", () => {
  assert.equal(
    resolveGeoAdmissionMode({ env: { TEMPO_GEO_ADMISSION_MODE: "loose" } }),
    GEO_ADMISSION_MODES.SOFT
  );
});

test("resolveGeoAdmissionMode: override soft ignores env hard", () => {
  assert.equal(
    resolveGeoAdmissionMode({
      env: { TEMPO_GEO_ADMISSION_MODE: "hard" },
      override: "soft",
    }),
    GEO_ADMISSION_MODES.SOFT
  );
});

test("resolveGeoAdmissionMode: override hard ignores env soft", () => {
  assert.equal(
    resolveGeoAdmissionMode({
      env: { TEMPO_GEO_ADMISSION_MODE: "soft" },
      override: "hard",
    }),
    GEO_ADMISSION_MODES.HARD
  );
});

test("resolveGeoAdmissionMode: invalid override falls through to env", () => {
  assert.equal(
    resolveGeoAdmissionMode({
      env: { TEMPO_GEO_ADMISSION_MODE: "soft" },
      override: "bogus",
    }),
    GEO_ADMISSION_MODES.SOFT
  );
});

test("geoAdmissionDiagnostics: soft → bypassed true", () => {
  assert.deepEqual(geoAdmissionDiagnostics(GEO_ADMISSION_MODES.SOFT), {
    geoAdmissionMode: "soft",
    geoAdmissionBypassed: true,
  });
});

test("geoAdmissionDiagnostics: hard → bypassed false", () => {
  assert.deepEqual(geoAdmissionDiagnostics(GEO_ADMISSION_MODES.HARD), {
    geoAdmissionMode: "hard",
    geoAdmissionBypassed: false,
  });
});
