import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  createJob,
  getJob,
  setPhase,
  completeJob,
  _resetRefreshJobs,
  JOB_STATUS,
  JOB_PHASE,
} from "./refresh-job.mjs";

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

beforeEach(() => {
  _resetRefreshJobs();
});

test("createJob: creates a running job at the initial phase with ISO timestamps", () => {
  const job = createJob("user-1");
  assert.equal(job.jobId, "user-1", "jobId === userId");
  assert.equal(job.status, JOB_STATUS.RUNNING);
  assert.equal(job.phase, JOB_PHASE.INGESTING, "initial phase is ingesting");
  assert.equal(job.storyCount, null);
  assert.equal(job.failureReason, null);
  assert.equal(job.finishedAt, null);
  assert.match(job.startedAt, ISO_RE);
  assert.match(job.updatedAt, ISO_RE);
  // Returned + stored copies are value-equal (defensive copies, not the same ref).
  assert.deepEqual(getJob("user-1"), job);
});

test("createJob: throws on a missing/empty userId (never registers an unkeyed job)", () => {
  assert.throws(() => createJob(), /non-empty userId/);
  assert.throws(() => createJob(""), /non-empty userId/);
  assert.throws(() => createJob("   "), /non-empty userId/);
  assert.throws(() => createJob(null), /non-empty userId/);
});

test("createJob: same user overwrites a prior terminal state with a fresh running job", () => {
  const first = createJob("user-1");
  completeJob("user-1", { ok: true, storyCount: 3 });
  assert.equal(getJob("user-1").status, JOB_STATUS.DONE);

  const second = createJob("user-1");
  assert.notEqual(second, first, "a brand-new job object replaces the prior one");
  assert.equal(second.status, JOB_STATUS.RUNNING, "overwrite resets status to running");
  assert.equal(second.phase, JOB_PHASE.INGESTING, "overwrite resets phase to ingesting");
  assert.equal(second.storyCount, null, "overwrite clears prior storyCount");
  assert.equal(second.finishedAt, null, "overwrite clears prior finishedAt");
  assert.deepEqual(getJob("user-1"), second);
});

test("getJob: returns null when no job exists for the id", () => {
  assert.equal(getJob("nobody"), null);
});

test("getJob: is null-safe and never throws on missing/invalid ids", () => {
  assert.equal(getJob(undefined), null);
  assert.equal(getJob(""), null);
  assert.equal(getJob("   "), null);
  assert.equal(getJob(null), null);
  // A real, padded id still resolves to the stored job (positive path intact).
  createJob("user-1");
  assert.equal(getJob("  user-1  ").status, JOB_STATUS.RUNNING);
});

test("setPhase: transitions a running job ingesting -> matching -> clustering", () => {
  createJob("user-1");
  const a = setPhase("user-1", JOB_PHASE.MATCHING);
  assert.equal(a.phase, JOB_PHASE.MATCHING);
  assert.match(a.updatedAt, ISO_RE);
  const b = setPhase("user-1", JOB_PHASE.CLUSTERING);
  assert.equal(b.phase, JOB_PHASE.CLUSTERING);
  // Still running; not terminal.
  assert.equal(getJob("user-1").status, JOB_STATUS.RUNNING);
});

test("setPhase: rejects an invalid phase", () => {
  createJob("user-1");
  assert.throws(() => setPhase("user-1", "bogus"), /invalid running phase/);
  // `done` is terminal-only and not a valid running phase via setPhase.
  assert.throws(() => setPhase("user-1", JOB_PHASE.DONE), /invalid running phase/);
  // Phase is unchanged after a rejected transition.
  assert.equal(getJob("user-1").phase, JOB_PHASE.INGESTING);
});

test("setPhase: rejects when the job is missing", () => {
  assert.throws(() => setPhase("ghost", JOB_PHASE.MATCHING), /no job for jobId/);
});

test("setPhase: rejects once the job is terminal (not running)", () => {
  createJob("user-1");
  completeJob("user-1", { ok: true });
  assert.throws(() => setPhase("user-1", JOB_PHASE.MATCHING), /not running/);
});

test("completeJob(ok=true): sets done + phase done + storyCount + finishedAt", () => {
  createJob("user-1");
  setPhase("user-1", JOB_PHASE.CLUSTERING);
  const job = completeJob("user-1", { ok: true, storyCount: 5 });
  assert.equal(job.status, JOB_STATUS.DONE);
  assert.equal(job.phase, JOB_PHASE.DONE);
  assert.equal(job.storyCount, 5);
  assert.equal(job.failureReason, null);
  assert.match(job.finishedAt, ISO_RE);
});

test("completeJob(ok=true): storyCount defaults to null when omitted", () => {
  createJob("user-1");
  const job = completeJob("user-1", { ok: true });
  assert.equal(job.status, JOB_STATUS.DONE);
  assert.equal(job.storyCount, null);
});

test("completeJob(ok=false): sets failed + failureReason + phase done + finishedAt", () => {
  createJob("user-1");
  setPhase("user-1", JOB_PHASE.CLUSTERING);
  const job = completeJob("user-1", { ok: false, failureReason: "clustering_timeout" });
  assert.equal(job.status, JOB_STATUS.FAILED);
  assert.equal(job.phase, JOB_PHASE.DONE, "terminal uniformity: failed also lands on done phase");
  assert.equal(job.failureReason, "clustering_timeout");
  assert.equal(job.storyCount, null, "failed jobs carry no storyCount");
  assert.match(job.finishedAt, ISO_RE);
});

test("completeJob: throws when the job is missing", () => {
  assert.throws(() => completeJob("ghost", { ok: true }), /no job for jobId/);
});

// ─── Slice 5 hardening: ok validation, key normalization, defensive copies ───

test("completeJob: throws when `ok` is missing", () => {
  createJob("user-1");
  assert.throws(() => completeJob("user-1", {}), /`ok` must be a boolean/);
  assert.throws(() => completeJob("user-1"), /`ok` must be a boolean/);
  // The job is left untouched (still running) by the rejected call.
  assert.equal(getJob("user-1").status, JOB_STATUS.RUNNING);
});

test("completeJob: throws when `ok` is non-boolean", () => {
  createJob("user-1");
  assert.throws(() => completeJob("user-1", { ok: "true" }), /`ok` must be a boolean/);
  assert.throws(() => completeJob("user-1", { ok: 1 }), /`ok` must be a boolean/);
  assert.throws(() => completeJob("user-1", { ok: null }), /`ok` must be a boolean/);
  assert.equal(getJob("user-1").status, JOB_STATUS.RUNNING);
});

test("keys are normalized (trimmed): createJob(\" user-1 \") is retrievable via \"user-1\"", () => {
  const created = createJob(" user-1 ");
  assert.equal(created.jobId, "user-1", "stored key is trimmed");
  assert.equal(created.userId, "user-1");
  assert.ok(getJob("user-1"), "retrievable by the trimmed id");
  assert.ok(getJob("  user-1  "), "retrievable by an equivalent padded id");
});

test("setPhase / completeJob accept equivalent trimmed ids", () => {
  createJob("user-1");
  // Padded id addresses the same job.
  const phased = setPhase("  user-1  ", JOB_PHASE.MATCHING);
  assert.equal(phased.phase, JOB_PHASE.MATCHING);
  assert.equal(getJob("user-1").phase, JOB_PHASE.MATCHING);
  const done = completeJob(" user-1 ", { ok: true, storyCount: 4 });
  assert.equal(done.status, JOB_STATUS.DONE);
  assert.equal(getJob("user-1").storyCount, 4);
});

test("returned objects are defensive copies — mutating them does not affect the registry", () => {
  const created = createJob("user-1");
  created.status = "tampered";
  created.phase = "tampered";
  assert.equal(getJob("user-1").status, JOB_STATUS.RUNNING, "createJob return is a copy");
  assert.equal(getJob("user-1").phase, JOB_PHASE.INGESTING);

  const read = getJob("user-1");
  read.storyCount = 999;
  assert.equal(getJob("user-1").storyCount, null, "getJob return is a copy");

  const phased = setPhase("user-1", JOB_PHASE.CLUSTERING);
  phased.phase = "tampered";
  assert.equal(getJob("user-1").phase, JOB_PHASE.CLUSTERING, "setPhase return is a copy");

  const done = completeJob("user-1", { ok: true });
  done.failureReason = "tampered";
  assert.equal(getJob("user-1").failureReason, null, "completeJob return is a copy");
});

test("retention: a terminal job remains retrievable until the next createJob overwrites it", () => {
  createJob("user-1");
  completeJob("user-1", { ok: true, storyCount: 2 });
  // No TTL: the terminal state is still there on subsequent reads.
  assert.equal(getJob("user-1").status, JOB_STATUS.DONE);
  assert.equal(getJob("user-1").storyCount, 2);
  // Only the same user's next createJob replaces it.
  createJob("user-1");
  assert.equal(getJob("user-1").status, JOB_STATUS.RUNNING);
});

test("_resetRefreshJobs: clears the in-memory registry", () => {
  createJob("user-1");
  createJob("user-2");
  assert.ok(getJob("user-1") && getJob("user-2"));
  _resetRefreshJobs();
  assert.equal(getJob("user-1"), null);
  assert.equal(getJob("user-2"), null);
});
