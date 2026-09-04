import test from "node:test";
import assert from "node:assert/strict";

import {
  selectDueUsers,
  listSnapshotAnchors,
  runDueRefreshes,
} from "./due-user-orchestrator.mjs";
import { REFRESH_INTERVAL_MS } from "../contracts-runtime/index.mjs";

const NOW = Date.parse("2026-05-28T12:00:00.000Z");

// ─── selectDueUsers (pure due logic) ─────────────────────────────────────────

test("selectDueUsers: user whose elapsed interval is below threshold is skipped", () => {
  const oneMinuteAgo = new Date(NOW - 60_000).toISOString();
  const due = selectDueUsers({
    users: [{ userId: "u-fresh", lastRefreshAttemptAt: oneMinuteAgo }],
    now: NOW,
  });
  assert.deepEqual(due, [], "user inside the cadence window must not be selected");
});

test("selectDueUsers: user whose elapsed interval ≥ threshold is selected", () => {
  const overdue = new Date(NOW - (REFRESH_INTERVAL_MS + 1)).toISOString();
  const due = selectDueUsers({
    users: [{ userId: "u-overdue", lastRefreshAttemptAt: overdue }],
    now: NOW,
  });
  assert.deepEqual(due, ["u-overdue"]);
});

test("selectDueUsers: exactly-at-interval user is due (>= comparison)", () => {
  const exact = new Date(NOW - REFRESH_INTERVAL_MS).toISOString();
  const due = selectDueUsers({
    users: [{ userId: "u-exact", lastRefreshAttemptAt: exact }],
    now: NOW,
  });
  assert.deepEqual(due, ["u-exact"]);
});

test("selectDueUsers: null / missing / unparseable anchor → due (first-pass coverage for legacy snapshots)", () => {
  const due = selectDueUsers({
    users: [
      { userId: "u-null", lastRefreshAttemptAt: null },
      { userId: "u-undef" },
      { userId: "u-bogus", lastRefreshAttemptAt: "not-a-timestamp" },
    ],
    now: NOW,
  });
  assert.deepEqual(due, ["u-null", "u-undef", "u-bogus"]);
});

test("selectDueUsers: mixed batch yields only the overdue subset, preserving input order", () => {
  const fresh = new Date(NOW - 60_000).toISOString();
  const overdue = new Date(NOW - (REFRESH_INTERVAL_MS + 60_000)).toISOString();
  const due = selectDueUsers({
    users: [
      { userId: "a-overdue", lastRefreshAttemptAt: overdue },
      { userId: "b-fresh", lastRefreshAttemptAt: fresh },
      { userId: "c-overdue", lastRefreshAttemptAt: overdue },
    ],
    now: NOW,
  });
  assert.deepEqual(due, ["a-overdue", "c-overdue"]);
});

test("selectDueUsers: skips malformed user records (missing/empty userId)", () => {
  const overdue = new Date(NOW - (REFRESH_INTERVAL_MS + 1)).toISOString();
  const due = selectDueUsers({
    users: [
      null,
      undefined,
      { userId: "", lastRefreshAttemptAt: overdue },
      { lastRefreshAttemptAt: overdue },
      { userId: "u-ok", lastRefreshAttemptAt: overdue },
    ],
    now: NOW,
  });
  assert.deepEqual(due, ["u-ok"]);
});

test("selectDueUsers: returns [] for non-array input", () => {
  assert.deepEqual(selectDueUsers({ users: null }), []);
  assert.deepEqual(selectDueUsers({ users: undefined }), []);
  assert.deepEqual(selectDueUsers({}), []);
});

// ─── listSnapshotAnchors (Supabase fluent-builder mock) ──────────────────────

function createAnchorsClient({ rows = null, error = null } = {}) {
  const calls = { from: [], select: [] };
  const builder = {
    from(table) {
      calls.from.push(table);
      return builder;
    },
    select(columns) {
      calls.select.push(columns);
      return Promise.resolve({ data: rows, error });
    },
  };
  return { client: builder, calls };
}

test("listSnapshotAnchors: extracts _lastCheckedAt when present on the persisted payload", async () => {
  const rows = [
    {
      user_id: "u-with-checked",
      payload: { _lastCheckedAt: "2026-05-28T11:00:00.000Z" },
      refreshed_at: "2026-05-28T10:00:00.000Z",
    },
  ];
  const { client, calls } = createAnchorsClient({ rows });
  const res = await listSnapshotAnchors({ supabase: client });
  assert.equal(res.error, null);
  assert.deepEqual(calls.from, ["dashboard_snapshots"]);
  assert.deepEqual(res.rows, [
    { userId: "u-with-checked", lastRefreshAttemptAt: "2026-05-28T11:00:00.000Z" },
  ]);
});

test("listSnapshotAnchors: falls back to refreshed_at when payload lacks _lastCheckedAt (legacy snapshot)", async () => {
  const rows = [
    {
      user_id: "u-legacy",
      payload: { stories: [] },
      refreshed_at: "2026-05-28T09:00:00.000Z",
    },
  ];
  const { client } = createAnchorsClient({ rows });
  const res = await listSnapshotAnchors({ supabase: client });
  assert.deepEqual(res.rows, [
    { userId: "u-legacy", lastRefreshAttemptAt: "2026-05-28T09:00:00.000Z" },
  ]);
});

test("listSnapshotAnchors: surfaces null anchor when payload AND refreshed_at are both missing", async () => {
  const rows = [{ user_id: "u-rotten", payload: null, refreshed_at: null }];
  const { client } = createAnchorsClient({ rows });
  const res = await listSnapshotAnchors({ supabase: client });
  assert.deepEqual(res.rows, [{ userId: "u-rotten", lastRefreshAttemptAt: null }]);
});

test("listSnapshotAnchors: skips rows with empty user_id", async () => {
  const rows = [
    { user_id: "", payload: {}, refreshed_at: "2026-05-28T08:00:00.000Z" },
    { user_id: "u-ok", payload: {}, refreshed_at: "2026-05-28T08:00:00.000Z" },
  ];
  const { client } = createAnchorsClient({ rows });
  const res = await listSnapshotAnchors({ supabase: client });
  assert.equal(res.rows.length, 1);
  assert.equal(res.rows[0].userId, "u-ok");
});

test("listSnapshotAnchors: surfaces supabase errors via { rows: [], error }", async () => {
  const { client } = createAnchorsClient({ error: { message: "boom" } });
  const res = await listSnapshotAnchors({ supabase: client });
  assert.deepEqual(res.rows, []);
  assert.deepEqual(res.error, { message: "boom" });
});

// ─── runDueRefreshes (end-to-end orchestration) ──────────────────────────────

test("runDueRefreshes: user not due → executor never invoked, summary reports skipped", async () => {
  const fresh = new Date(NOW - 60_000).toISOString();
  const executorCalls = [];
  const summary = await runDueRefreshes({
    listAnchorsFn: async () => ({
      rows: [{ userId: "u-fresh", lastRefreshAttemptAt: fresh }],
      error: null,
    }),
    executeRefreshFlowFn: async (identity) => {
      executorCalls.push(identity);
      return { kind: "ran" };
    },
    now: NOW,
  });
  assert.equal(summary.candidates, 1);
  assert.equal(summary.due, 0);
  assert.equal(summary.ran, 0);
  assert.equal(executorCalls.length, 0, "fresh user must not trigger an executor call");
});

test("runDueRefreshes: user due → executor invoked with orchestrator identity, anchor advances", async () => {
  // In-memory anchor map standing in for `dashboard_snapshots.payload._lastCheckedAt`.
  // Each executor call stamps a new anchor — mirroring the real `executeRefreshFlow`
  // which writes `_lastCheckedAt` on every refresh branch via `writeSnapshotMeta`.
  const anchors = new Map([
    ["u-overdue", new Date(NOW - (REFRESH_INTERVAL_MS + 60_000)).toISOString()],
  ]);
  const executorCalls = [];
  const executorStub = async (identity) => {
    executorCalls.push(identity);
    anchors.set(identity.userId, new Date(NOW).toISOString());
    return { kind: "ran" };
  };
  const listAnchorsFn = async () => ({
    rows: [...anchors.entries()].map(([userId, lastRefreshAttemptAt]) => ({
      userId,
      lastRefreshAttemptAt,
    })),
    error: null,
  });

  const first = await runDueRefreshes({
    listAnchorsFn,
    executeRefreshFlowFn: executorStub,
    now: NOW,
  });
  assert.equal(first.due, 1);
  assert.equal(first.ran, 1);
  assert.deepEqual(executorCalls, [{ userId: "u-overdue", source: "orchestrator" }]);
  assert.equal(first.kinds.ran, 1);

  // Re-run the orchestrator at the same `now` — the anchor moved into the window,
  // so the same user must NOT be selected again.  This is the "anchor updated
  // appropriately" assertion: a single orchestrator pass exits the due set
  // until the next interval elapses.
  const second = await runDueRefreshes({
    listAnchorsFn,
    executeRefreshFlowFn: executorStub,
    now: NOW,
  });
  assert.equal(second.due, 0, "anchor must advance past the executor call");
  assert.equal(second.ran, 0);
  assert.equal(executorCalls.length, 1, "no second executor call for the same user");
});

test("runDueRefreshes: mixed batch — only due users hit the executor; summary tallies kinds", async () => {
  const fresh = new Date(NOW - 60_000).toISOString();
  const overdue = new Date(NOW - (REFRESH_INTERVAL_MS + 60_000)).toISOString();
  const executorCalls = [];
  const kindByUser = { "u-overdue-a": "ran", "u-overdue-b": "unchanged" };

  const summary = await runDueRefreshes({
    listAnchorsFn: async () => ({
      rows: [
        { userId: "u-fresh", lastRefreshAttemptAt: fresh },
        { userId: "u-overdue-a", lastRefreshAttemptAt: overdue },
        { userId: "u-overdue-b", lastRefreshAttemptAt: overdue },
      ],
      error: null,
    }),
    executeRefreshFlowFn: async (identity) => {
      executorCalls.push(identity.userId);
      return { kind: kindByUser[identity.userId] ?? "ran" };
    },
    now: NOW,
  });
  assert.equal(summary.candidates, 3);
  assert.equal(summary.due, 2);
  assert.equal(summary.ran, 2);
  assert.deepEqual(executorCalls, ["u-overdue-a", "u-overdue-b"]);
  assert.deepEqual(summary.kinds, { ran: 1, unchanged: 1 });
});

test("runDueRefreshes: executor throw is counted as an error and does not abort the run", async () => {
  const overdue = new Date(NOW - (REFRESH_INTERVAL_MS + 1)).toISOString();
  const executorCalls = [];
  const summary = await runDueRefreshes({
    listAnchorsFn: async () => ({
      rows: [
        { userId: "u-boom", lastRefreshAttemptAt: overdue },
        { userId: "u-ok", lastRefreshAttemptAt: overdue },
      ],
      error: null,
    }),
    executeRefreshFlowFn: async (identity) => {
      executorCalls.push(identity.userId);
      if (identity.userId === "u-boom") throw new Error("pipeline blew up");
      return { kind: "ran" };
    },
    now: NOW,
  });
  assert.equal(summary.due, 2);
  assert.equal(summary.ran, 1);
  assert.equal(summary.errors, 1);
  assert.deepEqual(executorCalls, ["u-boom", "u-ok"]);
});

test("runDueRefreshes: anchor list error short-circuits the run (no executor calls)", async () => {
  const executorCalls = [];
  const summary = await runDueRefreshes({
    listAnchorsFn: async () => ({ rows: [], error: { message: "supabase down" } }),
    executeRefreshFlowFn: async (id) => {
      executorCalls.push(id);
      return { kind: "ran" };
    },
    now: NOW,
  });
  assert.equal(summary.skippedReason, "list_error");
  assert.equal(summary.due, 0);
  assert.equal(executorCalls.length, 0);
});

test("runDueRefreshes: anchor list throw is captured as list_threw, no executor calls", async () => {
  const summary = await runDueRefreshes({
    listAnchorsFn: async () => {
      throw new Error("network unreachable");
    },
    executeRefreshFlowFn: async () => ({ kind: "ran" }),
    now: NOW,
  });
  assert.equal(summary.skippedReason, "list_threw");
  assert.match(summary.error, /network unreachable/);
});

test("runDueRefreshes: missing fns rejects with TypeError (sub-slice 2.5 wiring guard)", async () => {
  await assert.rejects(() => runDueRefreshes({}), TypeError);
  await assert.rejects(
    () => runDueRefreshes({ listAnchorsFn: async () => ({ rows: [], error: null }) }),
    TypeError
  );
});
