import { test } from "node:test";
import assert from "node:assert/strict";
import { readSourceAliasMap } from "./source-aliases-repo.mjs";

// Mock Supabase client returning `rows` (or `error`) for the
// `source_aliases` select chain used by readSourceAliasMap. Rows mirror the
// real PostgREST shape: alias_raw + alias_normalized columns plus the embedded
// `source_entities` to-one relationship carrying canonical_name.
function makeMockSupabase(rows, error = null) {
  const result = { data: rows, error };
  const builder = { select: async () => result };
  return { from: () => builder };
}

test("readSourceAliasMap: maps real rows to alias-key → canonical_name (normalized + raw keys)", async () => {
  const map = await readSourceAliasMap({
    supabase: makeMockSupabase([
      {
        alias_raw: "WaPo",
        alias_normalized: "wapo",
        source_entities: { canonical_name: "Washington Post" },
      },
      {
        alias_raw: "El Tiempo CO",
        alias_normalized: "el tiempo co",
        source_entities: { canonical_name: " El Tiempo " }, // trimmed
      },
    ]),
  });
  assert.deepEqual(map, {
    wapo: "Washington Post",
    "el tiempo co": "El Tiempo",
  });
});

test("readSourceAliasMap: indexes raw spelling separately when it differs from normalized", async () => {
  // alias_normalized collapses internal whitespace; the lower/trim of alias_raw
  // may differ. Both keys must resolve to the same canonical so either form the
  // user types still matches.
  const map = await readSourceAliasMap({
    supabase: makeMockSupabase([
      {
        alias_raw: "New  York  Times", // double spaces — not collapsed by lower/trim
        alias_normalized: "new york times",
        source_entities: { canonical_name: "New York Times" },
      },
    ]),
  });
  assert.equal(map["new york times"], "New York Times");
  assert.equal(map["new  york  times"], "New York Times");
});

test("readSourceAliasMap: tolerates embedded relationship returned as an array", async () => {
  const map = await readSourceAliasMap({
    supabase: makeMockSupabase([
      {
        alias_raw: "AP",
        alias_normalized: "ap",
        source_entities: [{ canonical_name: "Associated Press" }],
      },
    ]),
  });
  assert.deepEqual(map, { ap: "Associated Press" });
});

test("readSourceAliasMap: drops rows with missing/blank canonical or no alias key", async () => {
  const map = await readSourceAliasMap({
    supabase: makeMockSupabase([
      { alias_raw: "WaPo", alias_normalized: "wapo", source_entities: { canonical_name: "Washington Post" } },
      { alias_raw: "orphan", alias_normalized: "orphan", source_entities: null },        // no entity
      { alias_raw: "blank", alias_normalized: "blank", source_entities: { canonical_name: "   " } }, // blank canonical
      { alias_raw: "", alias_normalized: "", source_entities: { canonical_name: "No Keys" } },       // no alias key
      null,
    ]),
  });
  assert.deepEqual(map, { wapo: "Washington Post" });
});

test("readSourceAliasMap: returns {} when no injected client and Supabase disabled", async () => {
  const prev = process.env.SUPABASE_URL;
  delete process.env.SUPABASE_URL;
  try {
    assert.deepEqual(await readSourceAliasMap(), {});
  } finally {
    if (prev !== undefined) process.env.SUPABASE_URL = prev;
  }
});

test("readSourceAliasMap: throws on query error (caller fails open)", async () => {
  await assert.rejects(
    () => readSourceAliasMap({ supabase: makeMockSupabase(null, { message: "boom" }) }),
    /source-aliases-repo.*boom/
  );
});
