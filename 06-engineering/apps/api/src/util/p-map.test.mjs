import { test } from "node:test";
import assert from "node:assert/strict";

import { pMap } from "./p-map.mjs";

// Small deterministic delay so the in-flight-tracking test can observe
// overlap.  Avoids real timers being flaky by resolving on the macrotask
// queue rather than asserting wall-clock durations.
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("pMap: empty array → []", async () => {
  let calls = 0;
  const out = await pMap([], async () => { calls += 1; }, 4);
  assert.deepEqual(out, []);
  assert.equal(calls, 0, "fn must not be invoked for an empty input");
});

test("pMap: preserves input order for a sequential fn (concurrency 1)", async () => {
  const items = [10, 20, 30, 40];
  const out = await pMap(items, async (n) => n * 2, 1);
  assert.deepEqual(
    out.map((r) => r.value),
    [20, 40, 60, 80]
  );
  assert.ok(out.every((r) => r.status === "fulfilled"));
});

test("pMap: result order follows input order independent of completion order", async () => {
  // Earlier items resolve LATER (descending delay) so completion order is the
  // reverse of input order — results must still be index-aligned.
  const items = [4, 3, 2, 1];
  const out = await pMap(items, async (n) => { await delay(n * 5); return n; }, 4);
  assert.deepEqual(out.map((r) => r.value), [4, 3, 2, 1]);
});

test("pMap: respects the concurrency cap (6 items, concurrency 2 → max in-flight ≤ 2)", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const items = [0, 1, 2, 3, 4, 5];
  const out = await pMap(
    items,
    async (n) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await delay(10);
      inFlight -= 1;
      return n;
    },
    2
  );
  assert.equal(out.length, 6);
  assert.ok(maxInFlight <= 2, `max in-flight must be ≤ 2, saw ${maxInFlight}`);
  assert.equal(maxInFlight, 2, "with 6 items the cap should actually be reached");
  assert.deepEqual(out.map((r) => r.value), items);
});

test("pMap: individual rejection captured as { status: 'rejected', reason } without failing the batch", async () => {
  const boom = new Error("task 2 failed");
  const items = [0, 1, 2, 3];
  const out = await pMap(
    items,
    async (n) => {
      if (n === 2) throw boom;
      return n * 10;
    },
    2
  );
  assert.equal(out.length, 4);
  assert.deepEqual(out[0], { status: "fulfilled", value: 0 });
  assert.deepEqual(out[1], { status: "fulfilled", value: 10 });
  assert.equal(out[2].status, "rejected");
  assert.equal(out[2].reason, boom, "the original error object is preserved as reason");
  assert.deepEqual(out[3], { status: "fulfilled", value: 30 });
});

test("pMap: concurrency greater than items.length still works (workerCount = items.length)", async () => {
  const items = [1, 2, 3];
  const out = await pMap(items, async (n) => n + 100, 99);
  assert.deepEqual(out.map((r) => r.value), [101, 102, 103]);
  assert.ok(out.every((r) => r.status === "fulfilled"));
});

test("pMap: concurrency ≤ 0 clamps up to 1 worker (degrades to sequential, no deadlock)", async () => {
  // Defensive: a misconfigured cap must not spin zero workers and hang.
  const items = [1, 2, 3];
  const out = await pMap(items, async (n) => n, 0);
  assert.deepEqual(out.map((r) => r.value), [1, 2, 3]);
});

test("pMap: passes the index as the second arg to fn", async () => {
  const items = ["a", "b", "c"];
  const out = await pMap(items, async (item, i) => `${item}:${i}`, 2);
  assert.deepEqual(out.map((r) => r.value), ["a:0", "b:1", "c:2"]);
});
