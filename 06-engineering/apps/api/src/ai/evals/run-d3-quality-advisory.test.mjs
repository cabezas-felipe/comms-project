import { test } from "node:test";
import assert from "node:assert/strict";

import {
  runD3QualityAdvisory,
  CHECKS,
  SCHEMA_VERSION,
} from "./run-d3-quality-advisory.mjs";

// ─── helpers ─────────────────────────────────────────────────────────────────

// Three synthetic checks — enough to prove continue-all (fail in the MIDDLE and
// confirm the one AFTER still runs) without spawning any child process.
const TEST_CHECKS = [
  { id: "alpha", script: "src/ai/evals/x-alpha.mjs" },
  { id: "beta", script: "src/ai/evals/x-beta.mjs" },
  { id: "gamma", script: "src/ai/evals/x-gamma.mjs" },
];

// Build an injectable runCheck stub from a map of id → outcome. Records the
// order of invocation so tests can assert continue-all.
function stubRunCheck(outcomes) {
  const calls = [];
  const fn = (check) => {
    calls.push(check.id);
    const o = outcomes[check.id] ?? { ok: true, durationMs: 1 };
    return {
      id: check.id,
      command: `node ${check.script}`,
      ok: o.ok,
      durationMs: o.durationMs ?? 1,
      startedAt: "2026-01-01T00:00:00.000Z",
      exitCode: o.ok ? 0 : 1,
      _output: o._output ?? "",
      _spawnError: o._spawnError ?? null,
    };
  };
  fn.calls = calls;
  return fn;
}

function makeHarness(outcomes, { checks = TEST_CHECKS } = {}) {
  const lines = [];
  const writes = [];
  const runCheck = stubRunCheck(outcomes);
  const result = runD3QualityAdvisory({
    checks,
    runCheck,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    writeArtifact: (artifactPath, artifact) => writes.push({ artifactPath, artifact }),
    logger: { log: (...args) => lines.push(args.join(" ")) },
    artifactPath: "/tmp/d3-test-artifact.json",
  });
  return { result, lines, writes, runCheck };
}

// ─── 1) continue-all ─────────────────────────────────────────────────────────
test("continue-all: a failing check does NOT stop the remaining checks", () => {
  const { result, runCheck } = makeHarness({
    alpha: { ok: true },
    beta: { ok: false }, // fails in the middle
    gamma: { ok: true },
  });
  // Every check ran, in order — beta failing did not short-circuit gamma.
  assert.deepEqual(runCheck.calls, ["alpha", "beta", "gamma"]);
  assert.equal(result.results.length, 3);
  assert.deepEqual(result.results.map((r) => r.id), ["alpha", "beta", "gamma"]);
});

// ─── 2) exit behavior ────────────────────────────────────────────────────────
test("exit code is 0 when all checks pass", () => {
  const { result } = makeHarness({ alpha: { ok: true }, beta: { ok: true }, gamma: { ok: true } });
  assert.equal(result.exitCode, 0);
  assert.equal(result.overallOk, true);
});

test("exit code is non-zero when any check fails", () => {
  const { result } = makeHarness({ alpha: { ok: true }, beta: { ok: false }, gamma: { ok: true } });
  assert.equal(result.exitCode, 1);
  assert.equal(result.overallOk, false);
});

test("exit code is non-zero when the FIRST check fails (still runs the rest)", () => {
  const { result, runCheck } = makeHarness({ alpha: { ok: false }, beta: { ok: true }, gamma: { ok: true } });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(runCheck.calls, ["alpha", "beta", "gamma"]);
});

// ─── 3) reporting contract ───────────────────────────────────────────────────
test("reporting: per-check status lines + final rollup appear in output", () => {
  const { lines } = makeHarness({
    alpha: { ok: true, durationMs: 12 },
    beta: { ok: false, durationMs: 34 },
    gamma: { ok: true, durationMs: 56 },
  });
  const out = lines.join("\n");

  // Per-check status lines (✓/✗ + PASS/FAIL + id).
  assert.match(out, /✓ alpha\s+PASS\s+\(12ms\)/);
  assert.match(out, /✗ beta\s+FAIL\s+\(34ms\)/);
  assert.match(out, /✓ gamma\s+PASS\s+\(56ms\)/);

  // Final rollup line.
  assert.match(out, /ROLLUP: 2\/3 checks passed — OVERALL FAIL/);
  // Artifact path line is surfaced.
  assert.match(out, /artifact: \/tmp\/d3-test-artifact\.json/);
});

test("reporting: a failing check surfaces its exit code and an output tail", () => {
  const { lines } = makeHarness({
    alpha: { ok: false, exitCode: 1, _output: "line-1\nline-2\nfinal-error-line" },
    beta: { ok: true },
    gamma: { ok: true },
  });
  const out = lines.join("\n");
  assert.match(out, /exitCode=1; last output lines:/);
  assert.match(out, /final-error-line/);
});

// ─── 4) artifact contract ────────────────────────────────────────────────────
test("artifact: written once with the required top-level shape", () => {
  const { writes, result } = makeHarness({ alpha: { ok: true }, beta: { ok: true }, gamma: { ok: true } });
  assert.equal(writes.length, 1, "artifact written exactly once");
  const { artifactPath, artifact } = writes[0];
  assert.equal(artifactPath, "/tmp/d3-test-artifact.json");
  assert.equal(artifact, result.artifact, "returned artifact matches the written one");

  assert.equal(artifact.schemaVersion, SCHEMA_VERSION);
  assert.equal(typeof artifact.startedAt, "string");
  assert.equal(typeof artifact.finishedAt, "string");
  assert.equal(artifact.overallOk, true);
  assert.ok(Array.isArray(artifact.checks));
  assert.equal(artifact.checks.length, 3);
});

test("artifact: each check entry has exactly {id, command, ok, durationMs}", () => {
  const { writes } = makeHarness({
    alpha: { ok: true, durationMs: 7 },
    beta: { ok: false, durationMs: 9 },
    gamma: { ok: true, durationMs: 11 },
  });
  const { artifact } = writes[0];
  for (const entry of artifact.checks) {
    assert.deepEqual(Object.keys(entry).sort(), ["command", "durationMs", "id", "ok"]);
    assert.equal(typeof entry.id, "string");
    assert.equal(typeof entry.command, "string");
    assert.equal(typeof entry.ok, "boolean");
    assert.equal(typeof entry.durationMs, "number");
  }
  // overallOk reflects the failing check.
  assert.equal(artifact.overallOk, false);
});

// ─── 5) lightweight artifact (no raw logs) ───────────────────────────────────
test("artifact is lightweight: no raw output / spawn fields leak into it", () => {
  const { writes } = makeHarness({
    alpha: { ok: false, _output: "SECRET RAW LOG CONTENT that must not be persisted", _spawnError: "ENOENT boom" },
    beta: { ok: true },
    gamma: { ok: true },
  });
  const serialized = JSON.stringify(writes[0].artifact);
  assert.ok(!serialized.includes("SECRET RAW LOG CONTENT"), "raw output must not be in the artifact");
  assert.ok(!serialized.includes("_output"), "no _output key in artifact");
  assert.ok(!serialized.includes("_spawnError"), "no _spawnError key in artifact");
  assert.ok(!serialized.includes("exitCode"), "no per-check exitCode in artifact");
  assert.ok(!serialized.includes("startedAt\":\"2026-01-01T00:00:00.000Z\",\"exitCode"), "no per-check startedAt leak");
});

// ─── 6) included-checks contract (locks decision #2) ─────────────────────────
test("CHECKS pins the four locked D3 checks in order", () => {
  assert.deepEqual(
    CHECKS.map((c) => c.id),
    ["dashboard-quality-gate", "dashboard-embassy-beat", "cache-benefit-advisory", "d2-narrative-stability"]
  );
  for (const c of CHECKS) {
    assert.match(c.script, /^src\/ai\/evals\/run-.*\.mjs$/);
  }
});
