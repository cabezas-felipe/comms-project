import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const tmpDir = await mkdtemp(path.join(tmpdir(), "tempo-rejection-log-"));
process.env.TEMPO_DATA_DIR = tmpDir;
const { appendRejections, readRejections, REJECTION_LOG_MAX_RETAINED } = await import(
  "./story-rejection-log-repo.mjs"
);

const USER_ID = "test-user-rejection";

before(() => {
  // No setup needed beyond temp dir.
});

after(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function makeRecord(overrides = {}) {
  return {
    meta_story_id: "x",
    reason_code: "no_valid_source_ids",
    source_item_ids: ["fake-1"],
    debug_payload: { factual_claims_count: 0 },
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

test("readRejections: returns [] when no rejections exist", async () => {
  const result = await readRejections("no-rejections-user");
  assert.deepEqual(result, []);
});

test("appendRejections + readRejections: persists records, newest first", async () => {
  const a = makeRecord({ meta_story_id: "a", reason_code: "no_valid_source_ids" });
  const b = makeRecord({ meta_story_id: "b", reason_code: "partial_source_ids" });
  await appendRejections(USER_ID, [a]);
  await appendRejections(USER_ID, [b]);
  const result = await readRejections(USER_ID);
  assert.equal(result.length, 2);
  // Newest write wins ordering — `b` written second, must appear first.
  assert.equal(result[0].meta_story_id, "b");
  assert.equal(result[1].meta_story_id, "a");
});

test("appendRejections: empty/null input is a no-op", async () => {
  const before = (await readRejections(USER_ID)).length;
  await appendRejections(USER_ID, []);
  await appendRejections(USER_ID, null);
  const after = (await readRejections(USER_ID)).length;
  assert.equal(after, before);
});

test("appendRejections: caps retention at MAX_RETAINED entries", async () => {
  const otherUser = "retention-user";
  // Write MAX_RETAINED + 5 records in a single batch — file adapter should cap.
  const batch = Array.from({ length: REJECTION_LOG_MAX_RETAINED + 5 }, (_, i) =>
    makeRecord({ meta_story_id: `r-${i}`, reason_code: "no_valid_source_ids" })
  );
  await appendRejections(otherUser, batch);
  const result = await readRejections(otherUser);
  assert.equal(result.length, REJECTION_LOG_MAX_RETAINED, "retention cap enforced");
});

test("appendRejections: preserves reason_code and structured fields verbatim", async () => {
  const reasonCheckUser = "reason-user";
  const record = makeRecord({
    meta_story_id: "specific",
    reason_code: "ungrounded_claims",
    source_item_ids: ["a", "b"],
    debug_payload: { factual_claims_count: 3, tags: { topics: ["x"] } },
  });
  await appendRejections(reasonCheckUser, [record]);
  const [stored] = await readRejections(reasonCheckUser);
  assert.equal(stored.reason_code, "ungrounded_claims");
  assert.deepEqual(stored.source_item_ids, ["a", "b"]);
  assert.equal(stored.debug_payload.factual_claims_count, 3);
});
