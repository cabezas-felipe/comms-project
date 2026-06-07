import test from "node:test";
import assert from "node:assert/strict";

import { mapIngestionKindToContractKind } from "./source-kind.mjs";

test("mapIngestionKindToContractKind: 'rss' → 'traditional'", () => {
  assert.equal(mapIngestionKindToContractKind("rss"), "traditional");
});

test("mapIngestionKindToContractKind: 'social' → 'social'", () => {
  assert.equal(mapIngestionKindToContractKind("social"), "social");
});

test("mapIngestionKindToContractKind: 'traditional' passes through", () => {
  assert.equal(mapIngestionKindToContractKind("traditional"), "traditional");
});

test("mapIngestionKindToContractKind: unknown/empty/null/non-string → 'traditional' (safe default)", () => {
  assert.equal(mapIngestionKindToContractKind("podcast"), "traditional");
  assert.equal(mapIngestionKindToContractKind(""), "traditional");
  assert.equal(mapIngestionKindToContractKind(null), "traditional");
  assert.equal(mapIngestionKindToContractKind(undefined), "traditional");
  assert.equal(mapIngestionKindToContractKind(42), "traditional");
  assert.equal(mapIngestionKindToContractKind({ kind: "rss" }), "traditional");
});

test("mapIngestionKindToContractKind: only ever returns a valid contract kind", () => {
  const valid = new Set(["traditional", "social"]);
  for (const input of ["rss", "social", "traditional", "x", "", null, undefined, 0, {}, []]) {
    assert.ok(valid.has(mapIngestionKindToContractKind(input)), `invalid for ${String(input)}`);
  }
});
