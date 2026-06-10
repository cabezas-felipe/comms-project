import { test } from "node:test";
import assert from "node:assert/strict";

// Importing the script must not spawn processes or touch the network — the
// entry-point guard keeps the real spawnSync/curl deps off the import path.
// These tests drive the pure orchestration (`prepareUser`) with recording
// stub deps, plus the pure helpers (`parseArgs`, `guardFailureMessage`).
const { parseArgs, prepareUser, guardFailureMessage } = await import("./e2e-prepare-user.mjs");

/**
 * Build a recording dep set. `assertResults` is the queue of results returned by
 * successive assertClean() calls (defaults to always-clean). Every side effect
 * appends a tag to `order` so tests can assert sequencing.
 */
function makeDeps({ assertResults = [], detectWarning = null } = {}) {
  const order = [];
  const assertCalls = [];
  let assertIdx = 0;
  return {
    order,
    assertCalls,
    deps: {
      log: (m) => order.push(`log:${m}`),
      startApi: () => order.push("startApi"),
      waitForApiHealth: () => order.push("waitForApiHealth"),
      resetUser: (args) => order.push(`resetUser:${args.userId}`),
      assertClean: ({ userId, label }) => {
        order.push(`assertClean:${label}`);
        assertCalls.push({ userId, label });
        const r = assertResults[assertIdx++] ?? { ok: true, output: "" };
        return r;
      },
      detectActiveWebSessions: () => {
        order.push("detect");
        return detectWarning;
      },
      startWeb: () => order.push("startWeb"),
      waitForWebReady: () => order.push("waitForWebReady"),
      preflight: () => order.push("preflight"),
    },
  };
}

const ARGS = { userId: "u1", email: "felipe@example.com" };

// ─── parseArgs ───────────────────────────────────────────────────────────────

test("parseArgs: requires --user-id and --email", () => {
  assert.throws(() => parseArgs([]), /Missing --user-id/);
  assert.throws(() => parseArgs(["--user-id", "u1"]), /Missing --email/);
});

test("parseArgs: backward-compatible CLI UX (--user-id / --email)", () => {
  const r = parseArgs(["--user-id", "u1", "--email", "a@b.com"]);
  assert.deepEqual(r, { userId: "u1", email: "a@b.com" });
});

test("parseArgs: rejects unknown argument", () => {
  assert.throws(() => parseArgs(["--user-id", "u1", "--email", "a@b.com", "--nope"]), /Unknown argument: --nope/);
});

// ─── two-phase ordering ──────────────────────────────────────────────────────

test("happy path: reset/assert/guard all happen before web start, ends at preflight + PASS", () => {
  const { order, deps } = makeDeps();
  prepareUser(ARGS, deps);

  // Web start must come strictly after both cleanliness checks.
  const idx = (tag) => order.indexOf(tag);
  const lastAssert = order.lastIndexOf("assertClean:baseline guard");
  assert.ok(idx("resetUser:u1") < idx("assertClean:post-reset baseline"));
  assert.ok(idx("assertClean:post-reset baseline") < lastAssert);
  assert.ok(lastAssert < idx("startWeb"), "web started before guard re-check");
  assert.ok(idx("startApi") < idx("startWeb"));

  // API is up before reset; web waits then preflight; ends in PASS.
  assert.ok(idx("waitForApiHealth") < idx("resetUser:u1"));
  assert.ok(idx("startWeb") < idx("waitForWebReady"));
  assert.ok(idx("waitForWebReady") < idx("preflight"));
  assert.ok(order.some((o) => o.startsWith("log:[e2e:prepare-user] PASS")));
});

test("two cleanliness checks run before any web step", () => {
  const { order, deps } = makeDeps();
  prepareUser(ARGS, deps);
  const asserts = order.filter((o) => o.startsWith("assertClean:"));
  assert.deepEqual(asserts, ["assertClean:post-reset baseline", "assertClean:baseline guard"]);
  // No web-related side effect appears before the guard check.
  const guardAt = order.indexOf("assertClean:baseline guard");
  const webBeforeGuard = order
    .slice(0, guardAt)
    .some((o) => o === "startWeb" || o === "waitForWebReady");
  assert.equal(webBeforeGuard, false);
});

// ─── guard failure path ──────────────────────────────────────────────────────

test("guard failure: second check failing exits non-zero with actionable message, web never starts", () => {
  const { order, deps } = makeDeps({
    assertResults: [
      { ok: true, output: "" }, // post-reset baseline passes
      { ok: false, output: "[e2e:assert-clean] FAIL user_id=u1 — baseline is dirty\n  dashboard_snapshots: 1 row(s)" },
    ],
  });

  assert.throws(
    () => prepareUser(ARGS, deps),
    (err) => {
      assert.match(err.message, /BASELINE GUARD FAILED/);
      assert.match(err.message, /baseline dirtied between reset and browser startup/);
      assert.match(err.message, /localhost:8080/);
      // Embeds the assert-clean dirty report.
      assert.match(err.message, /dashboard_snapshots: 1 row\(s\)/);
      return true;
    }
  );

  assert.ok(!order.includes("startWeb"), "web must not start after guard failure");
  assert.ok(!order.includes("preflight"), "preflight must not run after guard failure");
});

test("post-reset baseline failure aborts before the guard re-check and before web", () => {
  const { order, deps } = makeDeps({
    assertResults: [{ ok: false, output: "dirty after reset" }],
  });
  assert.throws(() => prepareUser(ARGS, deps), /post-reset baseline check failed/);
  // Only the first assert ran; no guard, no web.
  assert.deepEqual(order.filter((o) => o.startsWith("assertClean:")), ["assertClean:post-reset baseline"]);
  assert.ok(!order.includes("startWeb"));
});

// ─── active-session warning (optional robustness) ────────────────────────────

test("active-session warning is emitted (warning only) and does not block prep", () => {
  const { order, deps } = makeDeps({ detectWarning: "2 process(es) on :8080" });
  prepareUser(ARGS, deps);
  assert.ok(order.some((o) => o === "log:[e2e:prepare-user] WARNING: 2 process(es) on :8080"));
  // Warning never aborts: web still starts on a clean baseline.
  assert.ok(order.includes("startWeb"));
});

// ─── guardFailureMessage ─────────────────────────────────────────────────────

test("guardFailureMessage: actionable, names cause + rerun command + report", () => {
  const msg = guardFailureMessage({ userId: "u1", email: "a@b.com", report: "REPORT-LINES" });
  assert.match(msg, /BASELINE GUARD FAILED user_id=u1/);
  assert.match(msg, /active or stale session/);
  assert.match(msg, /close ALL http:\/\/localhost:8080 tabs/);
  assert.match(msg, /npm run e2e:prepare-user -- --user-id u1 --email a@b.com/);
  assert.match(msg, /REPORT-LINES/);
});

test("guardFailureMessage: omits report section when none captured", () => {
  const msg = guardFailureMessage({ userId: "u1", email: "a@b.com" });
  assert.doesNotMatch(msg, /dirty baseline details/);
});
