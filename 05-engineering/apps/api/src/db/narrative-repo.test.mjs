import { test } from "node:test";
import assert from "node:assert/strict";

// Ensure Supabase is disabled for all tests — these only exercise the fast-path
// exits (input guard and disabled check) which require no DB interaction or mocking.
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.SUPABASE_ANON_KEY;

const { readCurrentOnboardingNarrative, appendOnboardingNarrative } = await import("./narrative-repo.mjs");

// ─── input guard ──────────────────────────────────────────────────────────────

test("readCurrentOnboardingNarrative returns null when userId is null", async () => {
  assert.equal(await readCurrentOnboardingNarrative(null), null);
});

test("readCurrentOnboardingNarrative returns null when userId is undefined", async () => {
  assert.equal(await readCurrentOnboardingNarrative(undefined), null);
});

test("readCurrentOnboardingNarrative returns null when userId is empty string", async () => {
  assert.equal(await readCurrentOnboardingNarrative(""), null);
});

test("readCurrentOnboardingNarrative returns null when userId is whitespace-only", async () => {
  assert.equal(await readCurrentOnboardingNarrative("   "), null);
});

test("readCurrentOnboardingNarrative returns null when userId is a non-string type", async () => {
  assert.equal(await readCurrentOnboardingNarrative(42), null);
});

// ─── Supabase disabled ────────────────────────────────────────────────────────

test("readCurrentOnboardingNarrative returns null when Supabase is not configured", async () => {
  assert.equal(await readCurrentOnboardingNarrative("user-123"), null);
});

// ─── appendOnboardingNarrative — input guard ─────────────────────────────────

test("appendOnboardingNarrative resolves without throwing when userId is null", async () => {
  await assert.doesNotReject(() => appendOnboardingNarrative(null, "some text"));
});

test("appendOnboardingNarrative resolves without throwing when userId is undefined", async () => {
  await assert.doesNotReject(() => appendOnboardingNarrative(undefined, "some text"));
});

test("appendOnboardingNarrative resolves without throwing when userId is empty string", async () => {
  await assert.doesNotReject(() => appendOnboardingNarrative("", "some text"));
});

test("appendOnboardingNarrative resolves without throwing when userId is whitespace-only", async () => {
  await assert.doesNotReject(() => appendOnboardingNarrative("   ", "some text"));
});

test("appendOnboardingNarrative resolves without throwing when userId is a non-string type", async () => {
  await assert.doesNotReject(() => appendOnboardingNarrative(42, "some text"));
});

test("appendOnboardingNarrative resolves without throwing when rawText is empty string", async () => {
  await assert.doesNotReject(() => appendOnboardingNarrative("user-123", ""));
});

test("appendOnboardingNarrative resolves without throwing when rawText is whitespace-only", async () => {
  await assert.doesNotReject(() => appendOnboardingNarrative("user-123", "   "));
});

test("appendOnboardingNarrative resolves without throwing when rawText is a non-string type", async () => {
  await assert.doesNotReject(() => appendOnboardingNarrative("user-123", null));
});

// ─── appendOnboardingNarrative — Supabase disabled ───────────────────────────

test("appendOnboardingNarrative resolves without throwing when Supabase is not configured", async () => {
  await assert.doesNotReject(() => appendOnboardingNarrative("user-123", "Colombia diplomacy."));
});
