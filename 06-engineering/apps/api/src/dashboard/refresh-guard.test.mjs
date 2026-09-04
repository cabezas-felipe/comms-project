import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { tryAcquire, release, isInFlight, _resetInFlight } from "./refresh-guard.mjs";

afterEach(() => _resetInFlight());

test("tryAcquire: free slot returns true and marks user in-flight", () => {
  assert.equal(isInFlight("user-1"), false);
  assert.equal(tryAcquire("user-1"), true);
  assert.equal(isInFlight("user-1"), true);
});

test("tryAcquire: second call for same user returns false", () => {
  assert.equal(tryAcquire("user-1"), true);
  assert.equal(tryAcquire("user-1"), false, "concurrent caller must be denied");
});

test("release: clears the slot so a subsequent tryAcquire succeeds", () => {
  tryAcquire("user-1");
  release("user-1");
  assert.equal(isInFlight("user-1"), false);
  assert.equal(tryAcquire("user-1"), true);
});

test("tryAcquire: per-user — different users do not block each other", () => {
  assert.equal(tryAcquire("user-1"), true);
  assert.equal(tryAcquire("user-2"), true, "different user must not be blocked by another user's run");
});

test("tryAcquire: missing/empty userId returns true (defensive — never block unknown caller)", () => {
  assert.equal(tryAcquire(undefined), true);
  assert.equal(tryAcquire(""), true);
});

test("release: missing userId is a no-op", () => {
  release(undefined);
  release("");
  // No assertions — just must not throw.
  assert.ok(true);
});
