// Bounded-concurrency async map.
//
// Extracted verbatim (behavior-preserving) from feed-reader.mjs's private
// `pMap` so other stages — e.g. the Slice 6 parallel why-it-matters loop —
// can reuse the same worker-pool semantics without re-implementing them.
// feed-reader now imports this module.

/**
 * Run `fn` over `items` with at most `concurrency` invocations in flight at
 * once, returning a `Promise.allSettled`-style result array index-aligned with
 * the input.  Individual task failures are captured per index — a single
 * rejection never fails the whole batch.
 *
 * Worker-pool model: `workerCount = Math.max(1, Math.min(concurrency, items.length))`
 * workers pull from a shared cursor until the input is exhausted.  So:
 *   - `concurrency` larger than `items.length` is clamped down to
 *     `items.length` (no idle workers spun up).
 *   - `concurrency <= 0` (or any value `< 1`) is clamped up to 1 worker, so a
 *     misconfigured cap degrades to sequential rather than deadlocking.
 *   - an empty `items` array spins up zero workers and resolves to `[]`.
 *
 * Result order follows input order (a worker writes to `results[i]` for the
 * index `i` it claimed), independent of completion order.
 *
 * @template T, R
 * @param {T[]} items                          — inputs to map over.
 * @param {(item: T, index: number) => Promise<R>|R} fn — async (or sync) mapper.
 * @param {number} concurrency                 — max in-flight; clamped per the
 *                                                workerCount formula above.
 * @returns {Promise<Array<{ status: "fulfilled", value: R } | { status: "rejected", reason: unknown }>>}
 *   index-aligned settled results; `[]` for an empty input array.
 */
export async function pMap(items, fn, concurrency) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = [];
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  for (let w = 0; w < workerCount; w++) {
    workers.push((async () => {
      while (true) {
        const i = nextIndex++;
        if (i >= items.length) return;
        try {
          results[i] = { status: "fulfilled", value: await fn(items[i], i) };
        } catch (err) {
          results[i] = { status: "rejected", reason: err };
        }
      }
    })());
  }
  await Promise.all(workers);
  return results;
}
