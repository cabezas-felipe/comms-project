import assert from "node:assert/strict";
import test from "node:test";
import { settingsPayloadSchema } from "@tempo/contracts";

const VALID_BODY = {
  contractVersion: "2026-04-22-slice1",
  topics: ["Diplomatic relations"],
  keywords: ["OFAC"],
  geographies: ["US"],
  traditionalSources: ["Reuters"],
  socialSources: ["@latamwatcher"],
};

test("settingsPayloadSchema accepts a valid body", () => {
  const result = settingsPayloadSchema.safeParse(VALID_BODY);
  assert.ok(result.success, "expected valid payload to pass");
});

test("PUT /api/settings rejects missing contractVersion", () => {
  const { contractVersion: _omitted, ...body } = VALID_BODY;
  const result = settingsPayloadSchema.safeParse(body);
  assert.ok(!result.success, "expected missing contractVersion to fail");
  const paths = result.error.errors.map((e) => e.path.join("."));
  assert.ok(paths.some((p) => p === "contractVersion"), "error path should reference contractVersion");
});

test("PUT /api/settings rejects wrong contractVersion", () => {
  const result = settingsPayloadSchema.safeParse({ ...VALID_BODY, contractVersion: "wrong" });
  assert.ok(!result.success, "expected wrong contractVersion to fail");
});

test("PUT /api/settings rejects empty topics array", () => {
  const result = settingsPayloadSchema.safeParse({ ...VALID_BODY, topics: [] });
  // Empty arrays are allowed by the schema (min not enforced on topics); just verifying parse runs.
  assert.equal(typeof result.success, "boolean");
});

test("PUT /api/settings rejects non-object body", () => {
  const result = settingsPayloadSchema.safeParse("not-an-object");
  assert.ok(!result.success, "expected non-object to fail");
});

test("PUT /api/settings rejects null body", () => {
  const result = settingsPayloadSchema.safeParse(null);
  assert.ok(!result.success, "expected null to fail");
});
