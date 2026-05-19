import { test } from "node:test";
import assert from "node:assert/strict";

import {
  WHAT_CHANGED_COPY,
  compareStructuralGate,
  resolveWhatChangedDeterministic,
  trivialNormalizeText,
  resolveDeltaConfig,
  isDeltaLlmEnabled,
  buildDeltaPayload,
  parseClassifyResponse,
  validateChangedProse,
  checkHallucinationGuard,
  classifyDeltaMaterial,
  writeDeltaProse,
  resolveWhatChanged,
  _deltaClassifyClient,
  _deltaWriteClient,
} from "./what-changed-engine.mjs";

// ─── Fixtures ─────────────────────────────────────────────────────────────────
//
// Inline buildStory-shaped stories.  Only the fields the gate reads are
// populated — `id`, `metaStoryId`, `title`, `subtitle`, `summary`, and
// `sources[]` with `id`, `outlet`, `headline`, `minutesAgo`.  The gate
// intentionally does not read `topic`, `geographies`, `tags`, `priority`,
// `outletCount`, or `body`, so leaving them off keeps the fixtures terse.

function src(id, outlet, headline, minutesAgo = 10) {
  return { id, outlet, kind: "traditional", weight: 50, url: "https://x", minutesAgo, headline, body: ["b"] };
}

function story({
  metaStoryId = "ms-1",
  title = "Original title",
  subtitle = "Original subtitle.",
  summary = "Original summary.",
  sources = [src("src-1", "Reuters", "Headline A"), src("src-2", "NYT", "Headline B")],
} = {}) {
  return {
    id: metaStoryId,
    metaStoryId,
    title,
    subtitle,
    summary,
    takeaway: summary,
    whyItMatters: subtitle,
    whatChanged: "(placeholder)",
    geographies: [],
    priority: "standard",
    outletCount: sources.length,
    tags: { topics: [], keywords: [], geographies: [] },
    sources,
  };
}

// ─── trivialNormalizeText helper ─────────────────────────────────────────────

test("trivialNormalizeText: collapses whitespace, trims, lowercases", () => {
  assert.equal(trivialNormalizeText("  Hello   WORLD\n"), "hello world");
  assert.equal(trivialNormalizeText(""), "");
  assert.equal(trivialNormalizeText(null), "");
  assert.equal(trivialNormalizeText(undefined), "");
});

// ─── compareStructuralGate: not material → none ──────────────────────────────

test("gate: identical sources/title/subtitle/summary → none", () => {
  const prior = story();
  const current = story();
  const result = compareStructuralGate(prior, current);
  assert.equal(result.signal, "none");
  assert.deepEqual(result.reasons, []);
});

test("gate: reorder only (swap sources[] order, identical ids/headlines) → none", () => {
  const prior = story({
    sources: [src("src-1", "Reuters", "Headline A"), src("src-2", "NYT", "Headline B")],
  });
  const current = story({
    // Swapped order; identical id/outlet/headline.
    sources: [src("src-2", "NYT", "Headline B"), src("src-1", "Reuters", "Headline A")],
  });
  const result = compareStructuralGate(prior, current);
  assert.equal(result.signal, "none");
  assert.deepEqual(result.reasons, []);
});

test("gate: freshness tick only (minutesAgo changes, headlines identical) → none", () => {
  const prior = story({
    sources: [src("src-1", "Reuters", "Headline A", 30), src("src-2", "NYT", "Headline B", 45)],
  });
  const current = story({
    sources: [src("src-1", "Reuters", "Headline A", 1), src("src-2", "NYT", "Headline B", 5)],
  });
  const result = compareStructuralGate(prior, current);
  assert.equal(result.signal, "none");
  assert.deepEqual(result.reasons, []);
});

test("gate: tag-only / outletCount-only deltas → none (gate ignores those fields)", () => {
  const prior = story();
  // Mutate fields the gate is supposed to ignore; same evidence otherwise.
  const current = {
    ...story(),
    tags: { topics: ["Diplomatic relations"], keywords: ["OFAC"], geographies: ["US"] },
    outletCount: 99,
    priority: "top",
  };
  const result = compareStructuralGate(prior, current);
  assert.equal(result.signal, "none");
  assert.deepEqual(result.reasons, []);
});

// ─── compareStructuralGate: strong signals ───────────────────────────────────

test("gate: new sourceId + new outlet → strong with both reasons", () => {
  const prior = story({
    sources: [src("src-1", "Reuters", "Headline A"), src("src-2", "NYT", "Headline B")],
  });
  const current = story({
    sources: [
      src("src-1", "Reuters", "Headline A"),
      src("src-2", "NYT", "Headline B"),
      src("src-3", "Bloomberg", "Headline C"),
    ],
  });
  const result = compareStructuralGate(prior, current);
  assert.equal(result.signal, "strong");
  assert.ok(result.reasons.includes("added_source:src-3"));
  assert.ok(result.reasons.includes("new_outlet:bloomberg"));
});

test("gate: new sourceId from an existing outlet → strong (added_source) but no new_outlet", () => {
  const prior = story({
    sources: [src("src-1", "Reuters", "Headline A"), src("src-2", "NYT", "Headline B")],
  });
  const current = story({
    sources: [
      src("src-1", "Reuters", "Headline A"),
      src("src-2", "NYT", "Headline B"),
      // Same outlet, different real article — no syndication match because
      // the headline differs from any prior Reuters headline.
      src("src-1b", "Reuters", "Headline A — follow-up"),
    ],
  });
  const result = compareStructuralGate(prior, current);
  assert.equal(result.signal, "strong");
  assert.ok(result.reasons.includes("added_source:src-1b"));
  assert.ok(!result.reasons.some((r) => r.startsWith("new_outlet:")));
});

test("gate: headline change on overlapping id → strong (headline_change)", () => {
  const prior = story({
    sources: [src("src-1", "Reuters", "Original headline"), src("src-2", "NYT", "Other")],
  });
  const current = story({
    sources: [src("src-1", "Reuters", "Revised headline"), src("src-2", "NYT", "Other")],
  });
  const result = compareStructuralGate(prior, current);
  assert.equal(result.signal, "strong");
  assert.deepEqual(result.reasons, ["headline_change:src-1"]);
});

test("gate: trivial headline drift (whitespace + casing) → none, not headline_change", () => {
  const prior = story({
    sources: [src("src-1", "Reuters", "Original headline"), src("src-2", "NYT", "Other")],
  });
  const current = story({
    sources: [src("src-1", "Reuters", "  ORIGINAL   HEADLINE\n"), src("src-2", "NYT", "Other")],
  });
  const result = compareStructuralGate(prior, current);
  assert.equal(result.signal, "none");
  assert.deepEqual(result.reasons, []);
});

// ─── compareStructuralGate: weak signals ─────────────────────────────────────

test("gate: removed sourceId only → weak (removed_source)", () => {
  const prior = story({
    sources: [src("src-1", "Reuters", "A"), src("src-2", "NYT", "B")],
  });
  const current = story({
    sources: [src("src-1", "Reuters", "A")],
  });
  const result = compareStructuralGate(prior, current);
  assert.equal(result.signal, "weak");
  assert.deepEqual(result.reasons, ["removed_source:src-2"]);
});

test("gate: summary change only → weak (summary_change)", () => {
  const prior = story({ summary: "Original summary." });
  const current = story({ summary: "Materially different summary." });
  const result = compareStructuralGate(prior, current);
  assert.equal(result.signal, "weak");
  assert.deepEqual(result.reasons, ["summary_change"]);
});

test("gate: subtitle change only → weak (subtitle_change)", () => {
  const prior = story({ subtitle: "Original subtitle." });
  const current = story({ subtitle: "Subtitle now mentions a new angle." });
  const result = compareStructuralGate(prior, current);
  assert.equal(result.signal, "weak");
  assert.deepEqual(result.reasons, ["subtitle_change"]);
});

test("gate: title change only → weak (title_change), NOT strong", () => {
  const prior = story({ title: "Original title" });
  const current = story({ title: "Different title under the same lock id" });
  const result = compareStructuralGate(prior, current);
  // Defensive — titles are locked in production, but if the lock is missed
  // we surface it as a weak signal (editorial framing only), never strong.
  assert.equal(result.signal, "weak");
  assert.deepEqual(result.reasons, ["title_change"]);
});

// ─── compareStructuralGate: syndication suppression ──────────────────────────

test("gate: syndication duplicate (new id, same normalized outlet + headline) → none", () => {
  const prior = story({
    sources: [src("src-1", "Reuters", "Same headline text"), src("src-2", "NYT", "B")],
  });
  const current = story({
    sources: [
      src("src-1", "Reuters", "Same headline text"),
      src("src-2", "NYT", "B"),
      // New id, but outlet+headline duplicate of an existing Reuters source.
      src("src-3", "  reuters  ", "SAME HEADLINE TEXT"),
    ],
  });
  const result = compareStructuralGate(prior, current);
  assert.equal(result.signal, "none");
  assert.deepEqual(result.reasons, []);
});

test("gate: same outlet but a genuinely different headline → strong (not syndication)", () => {
  const prior = story({
    sources: [src("src-1", "Reuters", "Original Reuters headline")],
  });
  const current = story({
    sources: [
      src("src-1", "Reuters", "Original Reuters headline"),
      // Same outlet, different article — not a duplicate.
      src("src-1b", "Reuters", "A genuinely new Reuters story"),
    ],
  });
  const result = compareStructuralGate(prior, current);
  assert.equal(result.signal, "strong");
  assert.ok(result.reasons.includes("added_source:src-1b"));
  assert.ok(!result.reasons.some((r) => r.startsWith("new_outlet:")));
});

// ─── compareStructuralGate: aggregation ──────────────────────────────────────

test("gate: multiple weak + one strong aggregates to strong; reasons accumulate", () => {
  const prior = story({
    subtitle: "Sub before",
    summary: "Sum before",
    sources: [src("src-1", "Reuters", "A"), src("src-2", "NYT", "B")],
  });
  const current = story({
    subtitle: "Sub after",
    summary: "Sum after",
    sources: [
      // src-1 dropped → weak (removed_source:src-1)
      src("src-2", "NYT", "B"),
      // new outlet → strong (added_source + new_outlet)
      src("src-3", "Bloomberg", "C"),
    ],
  });
  const result = compareStructuralGate(prior, current);
  assert.equal(result.signal, "strong");
  assert.ok(result.reasons.includes("removed_source:src-1"));
  assert.ok(result.reasons.includes("added_source:src-3"));
  assert.ok(result.reasons.includes("new_outlet:bloomberg"));
  assert.ok(result.reasons.includes("summary_change"));
  assert.ok(result.reasons.includes("subtitle_change"));
});

test("gate: new_outlet fires at most once per normalized outlet across multiple new sources", () => {
  const prior = story({
    sources: [src("src-1", "Reuters", "A")],
  });
  const current = story({
    sources: [
      src("src-1", "Reuters", "A"),
      // Three new sources from the same brand-new outlet.
      src("src-2", "Bloomberg", "B1"),
      src("src-3", "Bloomberg", "B2"),
      src("src-4", "bloomberg ", "B3"),
    ],
  });
  const result = compareStructuralGate(prior, current);
  assert.equal(result.signal, "strong");
  const newOutletReasons = result.reasons.filter((r) => r.startsWith("new_outlet:"));
  assert.equal(newOutletReasons.length, 1, "new_outlet must fire exactly once per outlet");
  assert.equal(newOutletReasons[0], "new_outlet:bloomberg");
  // All three new ids still surface their added_source reason.
  assert.ok(result.reasons.includes("added_source:src-2"));
  assert.ok(result.reasons.includes("added_source:src-3"));
  assert.ok(result.reasons.includes("added_source:src-4"));
});

// ─── compareStructuralGate: defensive paths ──────────────────────────────────

test("gate: priorStory === null → { signal: 'none', reasons: [] }", () => {
  const result = compareStructuralGate(null, story());
  assert.equal(result.signal, "none");
  assert.deepEqual(result.reasons, []);
});

test("gate: ignores sources with missing id or empty outlet", () => {
  const prior = story({
    sources: [src("src-1", "Reuters", "A")],
  });
  const current = story({
    sources: [
      src("src-1", "Reuters", "A"),
      // Missing id — must not contribute added_source / new_outlet.
      { outlet: "Bloomberg", kind: "traditional", weight: 50, url: "https://x", minutesAgo: 10, headline: "X", body: ["b"] },
    ],
  });
  const result = compareStructuralGate(prior, current);
  assert.equal(result.signal, "none");
  assert.deepEqual(result.reasons, []);
});

// ─── resolveWhatChangedDeterministic ─────────────────────────────────────────

test("resolver: first-seen (id not in ever-seen) → first-seen copy + gate.signal=none", () => {
  const result = resolveWhatChangedDeterministic({
    metaStoryId: "ms-new",
    currentStory: story({ metaStoryId: "ms-new" }),
    priorStory: null,
    everSeenMetaStoryIds: ["ms-1", "ms-2"],
  });
  assert.equal(result.state, "first-seen");
  assert.equal(result.whatChanged, WHAT_CHANGED_COPY.firstSeen);
  assert.equal(result.gate.signal, "none");
  // Reason convention: tag the first-seen branch explicitly so downstream
  // observability can attribute the state without re-checking the set.
  assert.deepEqual(result.gate.reasons, ["first_seen"]);
});

test("resolver: ever-seen but priorStory absent → unchanged copy (re-entry) + reasons=['no_prior_story']", () => {
  const result = resolveWhatChangedDeterministic({
    metaStoryId: "ms-1",
    currentStory: story({ metaStoryId: "ms-1" }),
    priorStory: null,
    everSeenMetaStoryIds: ["ms-1", "ms-2"],
  });
  assert.equal(result.state, "unchanged");
  assert.equal(result.whatChanged, WHAT_CHANGED_COPY.unchanged);
  assert.equal(result.gate.signal, "none");
  assert.deepEqual(result.gate.reasons, ["no_prior_story"]);
});

test("resolver: ever-seen + prior + gate none → unchanged copy (spec §10 row 2)", () => {
  const prior = story({ metaStoryId: "ms-1" });
  const current = story({ metaStoryId: "ms-1" });
  const result = resolveWhatChangedDeterministic({
    metaStoryId: "ms-1",
    currentStory: current,
    priorStory: prior,
    everSeenMetaStoryIds: ["ms-1"],
  });
  assert.equal(result.state, "unchanged");
  assert.equal(result.whatChanged, WHAT_CHANGED_COPY.unchanged);
  assert.equal(result.gate.signal, "none");
  assert.deepEqual(result.gate.reasons, []);
});

test("resolver: ever-seen + prior + reorder only → unchanged copy + gate none (spec §10 row 11)", () => {
  const prior = story({
    metaStoryId: "ms-1",
    sources: [src("src-1", "Reuters", "A"), src("src-2", "NYT", "B")],
  });
  const current = story({
    metaStoryId: "ms-1",
    sources: [src("src-2", "NYT", "B"), src("src-1", "Reuters", "A")],
  });
  const result = resolveWhatChangedDeterministic({
    metaStoryId: "ms-1",
    currentStory: current,
    priorStory: prior,
    everSeenMetaStoryIds: ["ms-1"],
  });
  assert.equal(result.state, "unchanged");
  assert.equal(result.whatChanged, WHAT_CHANGED_COPY.unchanged);
  assert.equal(result.gate.signal, "none");
});

test("resolver: gate strong in Phase 2 still resolves to unchanged copy (LLM stages deferred)", () => {
  // Spec §10 row 9: headline change on overlapping source → gate strong.
  // Phase 2 doesn't write `changed` prose; the resolver must surface the
  // real gate signal so Phase 3 can branch on it without recomputing.
  const prior = story({
    metaStoryId: "ms-1",
    sources: [src("src-1", "Reuters", "Original headline"), src("src-2", "NYT", "Other")],
  });
  const current = story({
    metaStoryId: "ms-1",
    sources: [src("src-1", "Reuters", "Revised headline"), src("src-2", "NYT", "Other")],
  });
  const result = resolveWhatChangedDeterministic({
    metaStoryId: "ms-1",
    currentStory: current,
    priorStory: prior,
    everSeenMetaStoryIds: ["ms-1"],
  });
  assert.equal(result.state, "unchanged");
  assert.equal(result.whatChanged, WHAT_CHANGED_COPY.unchanged);
  assert.equal(result.gate.signal, "strong");
  assert.ok(result.gate.reasons.includes("headline_change:src-1"));
});

test("resolver: ever-seen + prior + gate weak (summary change) → unchanged copy + gate weak preserved", () => {
  const prior = story({ metaStoryId: "ms-1", summary: "before" });
  const current = story({ metaStoryId: "ms-1", summary: "after" });
  const result = resolveWhatChangedDeterministic({
    metaStoryId: "ms-1",
    currentStory: current,
    priorStory: prior,
    everSeenMetaStoryIds: ["ms-1"],
  });
  assert.equal(result.state, "unchanged");
  assert.equal(result.whatChanged, WHAT_CHANGED_COPY.unchanged);
  assert.equal(result.gate.signal, "weak");
  assert.deepEqual(result.gate.reasons, ["summary_change"]);
});

test("resolver: empty everSeenMetaStoryIds / missing input gracefully resolves to first-seen", () => {
  const result = resolveWhatChangedDeterministic({
    metaStoryId: "ms-1",
    currentStory: story({ metaStoryId: "ms-1" }),
    priorStory: null,
    everSeenMetaStoryIds: [],
  });
  assert.equal(result.state, "first-seen");
  assert.equal(result.whatChanged, WHAT_CHANGED_COPY.firstSeen);
});

test("resolver: handles non-array everSeenMetaStoryIds (treats as empty)", () => {
  const result = resolveWhatChangedDeterministic({
    metaStoryId: "ms-1",
    currentStory: story({ metaStoryId: "ms-1" }),
    priorStory: null,
    everSeenMetaStoryIds: null,
  });
  assert.equal(result.state, "first-seen");
  assert.equal(result.whatChanged, WHAT_CHANGED_COPY.firstSeen);
});

// ─── Phase 3: env / config / payload / parsers ───────────────────────────────

function withDeltaEnv(setup, run) {
  const saved = {
    enabled: process.env.TEMPO_AI_DELTA_ENABLED,
    classifyModel: process.env.TEMPO_AI_DELTA_CLASSIFY_MODEL,
    writeModel: process.env.TEMPO_AI_DELTA_WRITE_MODEL,
    timeout: process.env.TEMPO_AI_DELTA_TIMEOUT_MS,
    mockOnly: process.env.TEMPO_AI_MOCK_ONLY,
    apiKey: process.env.TEMPO_ANTHROPIC_API_KEY,
    altKey: process.env.ANTHROPIC_API_KEY,
  };
  const prevClassify = _deltaClassifyClient.create;
  const prevWrite = _deltaWriteClient.create;
  delete process.env.TEMPO_AI_DELTA_ENABLED;
  delete process.env.TEMPO_AI_DELTA_CLASSIFY_MODEL;
  delete process.env.TEMPO_AI_DELTA_WRITE_MODEL;
  delete process.env.TEMPO_AI_DELTA_TIMEOUT_MS;
  delete process.env.TEMPO_AI_MOCK_ONLY;
  delete process.env.TEMPO_ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  setup();
  const restore = () => {
    _deltaClassifyClient.create = prevClassify;
    _deltaWriteClient.create = prevWrite;
    if (saved.enabled !== undefined) process.env.TEMPO_AI_DELTA_ENABLED = saved.enabled;
    if (saved.classifyModel !== undefined) process.env.TEMPO_AI_DELTA_CLASSIFY_MODEL = saved.classifyModel;
    if (saved.writeModel !== undefined) process.env.TEMPO_AI_DELTA_WRITE_MODEL = saved.writeModel;
    if (saved.timeout !== undefined) process.env.TEMPO_AI_DELTA_TIMEOUT_MS = saved.timeout;
    if (saved.mockOnly !== undefined) process.env.TEMPO_AI_MOCK_ONLY = saved.mockOnly;
    if (saved.apiKey !== undefined) process.env.TEMPO_ANTHROPIC_API_KEY = saved.apiKey;
    if (saved.altKey !== undefined) process.env.ANTHROPIC_API_KEY = saved.altKey;
  };
  return Promise.resolve(run()).finally(restore);
}

test("resolveDeltaConfig: defaults when nothing set — disabled, Haiku 4.5, Sonnet 4.6, 2500ms", async () => {
  await withDeltaEnv(() => {}, () => {
    const cfg = resolveDeltaConfig();
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.mockOnly, false);
    assert.equal(cfg.classifyModel, "anthropic:claude-haiku-4-5-20251001");
    assert.equal(cfg.writeModel, "anthropic:claude-sonnet-4-6");
    assert.equal(cfg.timeoutMs, 2500);
  });
});

test("resolveDeltaConfig: TEMPO_AI_DELTA_ENABLED accepts 'true' and '1' (truthy convention)", async () => {
  await withDeltaEnv(() => { process.env.TEMPO_AI_DELTA_ENABLED = "true"; }, () => {
    assert.equal(resolveDeltaConfig().enabled, true);
    assert.equal(isDeltaLlmEnabled(), true);
  });
  await withDeltaEnv(() => { process.env.TEMPO_AI_DELTA_ENABLED = "1"; }, () => {
    assert.equal(resolveDeltaConfig().enabled, true);
  });
  await withDeltaEnv(() => { process.env.TEMPO_AI_DELTA_ENABLED = "TRUE"; }, () => {
    // Case-insensitive — anything that lowercases to "true" or "1" is on.
    assert.equal(resolveDeltaConfig().enabled, true);
  });
  await withDeltaEnv(() => { process.env.TEMPO_AI_DELTA_ENABLED = "yes"; }, () => {
    // Anything else is OFF — strict allowlist keeps config audits cheap.
    assert.equal(resolveDeltaConfig().enabled, false);
  });
});

test("resolveDeltaConfig: TEMPO_AI_MOCK_ONLY=true forces enabled=false even if DELTA_ENABLED=true", async () => {
  await withDeltaEnv(
    () => {
      process.env.TEMPO_AI_DELTA_ENABLED = "true";
      process.env.TEMPO_AI_MOCK_ONLY = "true";
    },
    () => {
      const cfg = resolveDeltaConfig();
      assert.equal(cfg.enabled, false, "MOCK_ONLY must veto the LLM path (spec §8)");
      assert.equal(cfg.mockOnly, true);
    }
  );
});

test("resolveDeltaConfig: env overrides for models + timeout are honored", async () => {
  await withDeltaEnv(
    () => {
      process.env.TEMPO_AI_DELTA_CLASSIFY_MODEL = "anthropic:claude-sonnet-4-6";
      process.env.TEMPO_AI_DELTA_WRITE_MODEL = "anthropic:claude-opus-4-7";
      process.env.TEMPO_AI_DELTA_TIMEOUT_MS = "1234";
    },
    () => {
      const cfg = resolveDeltaConfig();
      assert.equal(cfg.classifyModel, "anthropic:claude-sonnet-4-6");
      assert.equal(cfg.writeModel, "anthropic:claude-opus-4-7");
      assert.equal(cfg.timeoutMs, 1234);
    }
  );
});

test("resolveDeltaConfig: invalid TEMPO_AI_DELTA_TIMEOUT_MS falls back to 2500", async () => {
  await withDeltaEnv(() => { process.env.TEMPO_AI_DELTA_TIMEOUT_MS = "not-a-number"; }, () => {
    assert.equal(resolveDeltaConfig().timeoutMs, 2500);
  });
  await withDeltaEnv(() => { process.env.TEMPO_AI_DELTA_TIMEOUT_MS = "-5"; }, () => {
    assert.equal(resolveDeltaConfig().timeoutMs, 2500);
  });
});

// ── buildDeltaPayload ───────────────────────────────────────────────────────

function gateForAddedSource(priorStory, currentStory) {
  return compareStructuralGate(priorStory, currentStory);
}

test("buildDeltaPayload: classify stage — NO body excerpts (spec §6: bodies not sent to Haiku)", () => {
  const prior = story({
    sources: [src("src-1", "Reuters", "Headline A")],
  });
  const current = story({
    sources: [
      src("src-1", "Reuters", "Headline A"),
      { ...src("src-2", "Bloomberg", "Headline B"), body: ["A long body paragraph that should NOT be sent to Haiku."] },
    ],
  });
  const gate = gateForAddedSource(prior, current);
  const payload = buildDeltaPayload({
    metaStoryId: "ms-1",
    priorStory: prior,
    currentStory: current,
    gate,
    stage: "classify",
  });
  assert.equal(payload.metaStoryId, "ms-1");
  assert.equal(payload.gateSignal, "strong");
  assert.deepEqual(payload.diff.addedSourceIds, ["src-2"]);
  assert.deepEqual(payload.diff.removedSourceIds, []);
  assert.deepEqual(payload.diff.headlineChanges, []);
  // Headlines surface; bodies / excerpts do NOT.
  assert.ok(Array.isArray(payload.prior.headlines));
  assert.ok(payload.current.headlines.includes("Headline B"));
  assert.equal(payload.excerpts, undefined, "classify stage must not carry excerpts");
});

test("buildDeltaPayload: write stage — 400-char excerpts per added source from body, omitted when body missing", () => {
  const longBody = "x".repeat(800);
  const prior = story({ sources: [src("src-1", "Reuters", "A")] });
  const current = story({
    sources: [
      src("src-1", "Reuters", "A"),
      { ...src("src-2", "Bloomberg", "B"), body: [longBody] },
      { ...src("src-3", "AP", "C"), body: [] }, // no body — excerpt omitted
    ],
  });
  const gate = compareStructuralGate(prior, current);
  const payload = buildDeltaPayload({
    metaStoryId: "ms-1",
    priorStory: prior,
    currentStory: current,
    gate,
    stage: "write",
  });
  assert.ok(payload.excerpts, "write stage must include excerpts map");
  assert.equal(payload.excerpts["src-2"]?.length, 400, "excerpt must be capped at 400 chars");
  assert.ok(!Object.prototype.hasOwnProperty.call(payload.excerpts, "src-3"), "missing body must omit excerpt");
  assert.ok(!Object.prototype.hasOwnProperty.call(payload.excerpts, "src-1"), "non-added source must not have excerpt");
});

test("buildDeltaPayload: headlineChanges carries prior + current headline strings", () => {
  const prior = story({ sources: [src("src-1", "Reuters", "Original")] });
  const current = story({ sources: [src("src-1", "Reuters", "Revised")] });
  const gate = compareStructuralGate(prior, current);
  const payload = buildDeltaPayload({
    metaStoryId: "ms-1",
    priorStory: prior,
    currentStory: current,
    gate,
  });
  assert.deepEqual(payload.diff.headlineChanges, [
    { id: "src-1", priorHeadline: "Original", currentHeadline: "Revised" },
  ]);
});

// ── parseClassifyResponse ───────────────────────────────────────────────────

test("parseClassifyResponse: extracts {material, confidence, reasonCode} from plain JSON", () => {
  const parsed = parseClassifyResponse('{"material": true, "confidence": 0.92, "reasonCode": "new_outlet"}');
  assert.equal(parsed.material, true);
  assert.equal(parsed.confidence, 0.92);
  assert.equal(parsed.reasonCode, "new_outlet");
});

test("parseClassifyResponse: tolerates ```json``` markdown fence wrapping", () => {
  const parsed = parseClassifyResponse('```json\n{"material": false, "confidence": 0.4, "reasonCode": "syndication"}\n```');
  assert.equal(parsed.material, false);
  assert.equal(parsed.confidence, 0.4);
});

test("parseClassifyResponse: clamps confidence into [0,1]", () => {
  assert.equal(parseClassifyResponse('{"material": true, "confidence": 1.7}').confidence, 1);
  assert.equal(parseClassifyResponse('{"material": true, "confidence": -0.5}').confidence, 0);
});

test("parseClassifyResponse: throws when `material` is missing or non-boolean", () => {
  assert.throws(() => parseClassifyResponse('{"confidence": 0.9}'));
  assert.throws(() => parseClassifyResponse('{"material": "yes"}'));
});

test("parseClassifyResponse: throws on malformed JSON (caller fail-closes)", () => {
  assert.throws(() => parseClassifyResponse("not json"));
});

// ── validateChangedProse ────────────────────────────────────────────────────

test("validateChangedProse: accepts a single short sentence verbatim", () => {
  const r = validateChangedProse("Bloomberg added new coverage.", {});
  assert.equal(r.ok, true);
  assert.equal(r.prose, "Bloomberg added new coverage.");
});

test("validateChangedProse: strips 'Update:' prefix defensively", () => {
  const r = validateChangedProse("Update: Bloomberg added coverage.", {});
  assert.equal(r.ok, true);
  assert.equal(r.prose, "Bloomberg added coverage.");
});

test("validateChangedProse: 3 sentences → truncated to first 2 (soft cap)", () => {
  // Trade-off documented in module: truncate rather than fail-close on the
  // soft sentence-count violation; only length overflow is a hard fail.
  const r = validateChangedProse("One. Two. Three.", {});
  assert.equal(r.ok, true);
  assert.equal(r.prose, "One. Two.");
});

test("validateChangedProse: > 300 char output → fail-closed (length_overflow)", () => {
  const longSentence = `${"x".repeat(310)}.`;
  const r = validateChangedProse(longSentence, {});
  assert.equal(r.ok, false);
  assert.equal(r.reason, "length_overflow");
});

test("validateChangedProse: empty input → fail-closed (empty_prose)", () => {
  const r = validateChangedProse("   ", {});
  assert.equal(r.ok, false);
  assert.equal(r.reason, "empty_prose");
});

// ── checkHallucinationGuard ─────────────────────────────────────────────────

test("checkHallucinationGuard: outlet from allow-set passes", () => {
  const payload = { current: { sources: [{ outlet: "Reuters", headline: "H" }] }, prior: { sources: [] } };
  const r = checkHallucinationGuard("Reuters added new coverage of the situation.", payload);
  assert.equal(r.ok, true);
});

test("checkHallucinationGuard: outlet NOT in allow-set → flagged with offendingOutlet", () => {
  const payload = { current: { sources: [{ outlet: "Reuters", headline: "H" }] }, prior: { sources: [] } };
  const r = checkHallucinationGuard("Bloomberg added new coverage.", payload);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "unknown_outlet");
  assert.equal(r.offendingOutlet, "bloomberg");
});

test("checkHallucinationGuard: multi-word outlet 'The New York Times' detected in allow-set", () => {
  const payload = {
    current: { sources: [{ outlet: "The New York Times", headline: "H" }] },
    prior: { sources: [] },
  };
  const r = checkHallucinationGuard("The New York Times reported a new angle.", payload);
  assert.equal(r.ok, true);
});

test("checkHallucinationGuard: word-boundary safe — 'AFP' not matched inside 'scaffolding'-like words", () => {
  // The guard does whole-word matching against KNOWN_OUTLET_TOKENS, so a
  // substring hit inside an unrelated word must not trip.  Using "ftp" /
  // "rcnsomething" etc. would still pass; using "afp" alone we expect a
  // miss because there's no boundary around it in this prose.
  const payload = { current: { sources: [] }, prior: { sources: [] } };
  const r = checkHallucinationGuard("The dafplant grew quickly.", payload);
  assert.equal(r.ok, true);
});

// ── classifyDeltaMaterial (stub path) ───────────────────────────────────────

test("classifyDeltaMaterial: opts.classifyFn stub returns ok:true with stubbed material", async () => {
  const result = await classifyDeltaMaterial(
    { metaStoryId: "ms-1", gateSignal: "strong", gateReasons: [], prior: {}, current: {}, diff: {} },
    { classifyFn: async () => ({ material: true, confidence: 0.9, reasonCode: "new_outlet" }) }
  );
  assert.equal(result.material, true);
  assert.equal(result.ok, true);
  assert.equal(result.reasonCode, "new_outlet");
});

test("classifyDeltaMaterial: stub throws → ok:false + material:false (fail-closed)", async () => {
  const result = await classifyDeltaMaterial(
    { metaStoryId: "ms-1", gateSignal: "strong", gateReasons: [], prior: {}, current: {}, diff: {} },
    { classifyFn: async () => { throw new Error("simulated"); } }
  );
  assert.equal(result.ok, false);
  assert.equal(result.material, false);
  assert.equal(result.reasonCode, "classify_failed");
});

test("classifyDeltaMaterial: real path with mock provider → ok:false (CI safety, never invents verdicts)", async () => {
  await withDeltaEnv(
    () => { process.env.TEMPO_AI_MOCK_ONLY = "true"; },
    async () => {
      const result = await classifyDeltaMaterial(
        { metaStoryId: "ms-1", gateSignal: "strong", gateReasons: [], prior: {}, current: {}, diff: {} },
        { config: resolveDeltaConfig() }
      );
      assert.equal(result.ok, false);
      assert.equal(result.material, false);
    }
  );
});

// ── writeDeltaProse (stub path) ─────────────────────────────────────────────

test("writeDeltaProse: stub returns valid prose → ok:true with validated prose", async () => {
  const payload = {
    metaStoryId: "ms-1",
    prior: { sources: [] },
    current: { sources: [{ outlet: "Reuters", headline: "H" }] },
    diff: { addedSourceIds: ["src-1"], removedSourceIds: [], headlineChanges: [] },
  };
  const result = await writeDeltaProse(payload, { writeFn: async () => "Reuters expanded coverage of the diplomatic talks." });
  assert.equal(result.ok, true);
  assert.equal(result.prose, "Reuters expanded coverage of the diplomatic talks.");
});

test("writeDeltaProse: stub throws → ok:false (write_failed)", async () => {
  const payload = { prior: { sources: [] }, current: { sources: [] }, diff: {} };
  const result = await writeDeltaProse(payload, { writeFn: async () => { throw new Error("timeout"); } });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "write_failed");
});

test("writeDeltaProse: hallucinated outlet → ok:false with reason='hallucination'", async () => {
  const payload = {
    prior: { sources: [] },
    current: { sources: [{ outlet: "Reuters", headline: "H" }] },
    diff: {},
  };
  const result = await writeDeltaProse(payload, { writeFn: async () => "Bloomberg added new coverage." });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "hallucination");
});

test("writeDeltaProse: length overflow → ok:false (length_overflow)", async () => {
  const payload = { prior: { sources: [] }, current: { sources: [] }, diff: {} };
  const long = `${"x".repeat(320)}.`;
  const result = await writeDeltaProse(payload, { writeFn: async () => long });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "length_overflow");
});

// ─── resolveWhatChanged — async orchestrator (spec §10 mapping) ──────────────

// Helper: enabled config so the orchestrator routes through stubs.
function enabledConfig() {
  return { enabled: true, mockOnly: false, classifyModel: "anthropic:claude-haiku-4-5-20251001", writeModel: "anthropic:claude-sonnet-4-6", timeoutMs: 2500 };
}

test("spec §10 row 3 — strong gate + classify:true + write OK → state:'changed' with stub prose, no Update: prefix, ≤300 chars", async () => {
  const prior = story({
    metaStoryId: "ms-1",
    sources: [src("src-1", "Reuters", "Original")],
  });
  const current = story({
    metaStoryId: "ms-1",
    sources: [
      src("src-1", "Reuters", "Original"),
      src("src-3", "Bloomberg", "New Bloomberg headline"),
    ],
  });
  const result = await resolveWhatChanged(
    {
      metaStoryId: "ms-1",
      currentStory: current,
      priorStory: prior,
      everSeenMetaStoryIds: ["ms-1"],
    },
    {
      config: enabledConfig(),
      classifyFn: async () => ({ material: true, confidence: 0.9, reasonCode: "new_outlet" }),
      writeFn: async () => "Bloomberg added new coverage of the diplomatic situation.",
    }
  );
  assert.equal(result.state, "changed");
  assert.ok(result.whatChanged.length > 0);
  assert.ok(!/^update:/i.test(result.whatChanged), "must not carry an Update: prefix");
  assert.ok(result.whatChanged.length <= 300);
  assert.equal(result.diagnostics.classifyCalled, true);
  assert.equal(result.diagnostics.classifyMaterial, true);
  assert.equal(result.diagnostics.writeCalled, true);
  assert.equal(result.diagnostics.writeOk, true);
  assert.equal(result.diagnostics.llmFailed.classify, false);
  assert.equal(result.diagnostics.llmFailed.write, false);
});

test("spec §10 row 5 — classify:true but write throws → state:'unchanged' + llmFailed.write", async () => {
  const prior = story({ metaStoryId: "ms-1", sources: [src("src-1", "Reuters", "A")] });
  const current = story({
    metaStoryId: "ms-1",
    sources: [src("src-1", "Reuters", "A"), src("src-2", "Bloomberg", "B")],
  });
  const result = await resolveWhatChanged(
    {
      metaStoryId: "ms-1",
      currentStory: current,
      priorStory: prior,
      everSeenMetaStoryIds: ["ms-1"],
    },
    {
      config: enabledConfig(),
      classifyFn: async () => ({ material: true, confidence: 0.9, reasonCode: "x" }),
      writeFn: async () => { throw new Error("simulated timeout"); },
    }
  );
  assert.equal(result.state, "unchanged");
  assert.equal(result.whatChanged, WHAT_CHANGED_COPY.unchanged);
  assert.equal(result.diagnostics.writeCalled, true);
  assert.equal(result.diagnostics.writeOk, false);
  assert.equal(result.diagnostics.llmFailed.write, true);
  assert.equal(result.diagnostics.llmFailed.hallucination, false);
});

test("spec §10 row 7 — TEMPO_AI_MOCK_ONLY=true + strong gate → state:'unchanged' + classifySkipped, stubs NEVER called", async () => {
  let classifyCalled = false;
  let writeCalled = false;
  await withDeltaEnv(
    () => {
      // Even with DELTA_ENABLED on, MOCK_ONLY must veto LLM (spec §8).
      process.env.TEMPO_AI_DELTA_ENABLED = "true";
      process.env.TEMPO_AI_MOCK_ONLY = "true";
    },
    async () => {
      const prior = story({ metaStoryId: "ms-1", sources: [src("src-1", "Reuters", "A")] });
      const current = story({
        metaStoryId: "ms-1",
        sources: [src("src-1", "Reuters", "A"), src("src-2", "Bloomberg", "B")],
      });
      const result = await resolveWhatChanged(
        {
          metaStoryId: "ms-1",
          currentStory: current,
          priorStory: prior,
          everSeenMetaStoryIds: ["ms-1"],
        },
        {
          classifyFn: async () => { classifyCalled = true; return { material: true }; },
          writeFn: async () => { writeCalled = true; return "should not run"; },
        }
      );
      assert.equal(result.state, "unchanged");
      assert.equal(result.diagnostics.classifySkipped, true);
      assert.equal(result.diagnostics.classifyCalled, false);
      assert.equal(classifyCalled, false, "classify stub must not run in mock-only mode");
      assert.equal(writeCalled, false, "write stub must not run in mock-only mode");
    }
  );
});

test("spec §10 row 8 — strong gate + classify:false → state:'unchanged', write NOT called", async () => {
  let writeCalled = false;
  const prior = story({ metaStoryId: "ms-1", sources: [src("src-1", "Reuters", "A")] });
  const current = story({
    metaStoryId: "ms-1",
    sources: [src("src-1", "Reuters", "A"), src("src-2", "Bloomberg", "B")],
  });
  const result = await resolveWhatChanged(
    {
      metaStoryId: "ms-1",
      currentStory: current,
      priorStory: prior,
      everSeenMetaStoryIds: ["ms-1"],
    },
    {
      config: enabledConfig(),
      classifyFn: async () => ({ material: false, confidence: 0.6, reasonCode: "syndication_duplicate" }),
      writeFn: async () => { writeCalled = true; return "should not run"; },
    }
  );
  assert.equal(result.state, "unchanged");
  assert.equal(result.diagnostics.classifyCalled, true);
  assert.equal(result.diagnostics.classifyMaterial, false);
  assert.equal(result.diagnostics.writeCalled, false);
  assert.equal(writeCalled, false);
});

test("spec §10 row 9 — headline_change on overlapping id → gate strong + classify called", async () => {
  let classifyCalled = false;
  const prior = story({ metaStoryId: "ms-1", sources: [src("src-1", "Reuters", "Original")] });
  const current = story({ metaStoryId: "ms-1", sources: [src("src-1", "Reuters", "Revised")] });
  await resolveWhatChanged(
    {
      metaStoryId: "ms-1",
      currentStory: current,
      priorStory: prior,
      everSeenMetaStoryIds: ["ms-1"],
    },
    {
      config: enabledConfig(),
      classifyFn: async (payload) => {
        classifyCalled = true;
        assert.equal(payload.gateSignal, "strong");
        assert.ok(payload.diff.headlineChanges.some((h) => h.id === "src-1"));
        return { material: false }; // doesn't matter; we just want classify reached
      },
    }
  );
  assert.equal(classifyCalled, true);
});

test("spec §10 row 10 — TEMPO_AI_DELTA_ENABLED=false + strong gate → state:'unchanged' + classifySkipped, stubs ignored", async () => {
  let classifyCalled = false;
  await withDeltaEnv(
    () => { /* DELTA_ENABLED unset → defaults to disabled */ },
    async () => {
      const prior = story({ metaStoryId: "ms-1", sources: [src("src-1", "Reuters", "A")] });
      const current = story({
        metaStoryId: "ms-1",
        sources: [src("src-1", "Reuters", "A"), src("src-2", "Bloomberg", "B")],
      });
      const result = await resolveWhatChanged(
        {
          metaStoryId: "ms-1",
          currentStory: current,
          priorStory: prior,
          everSeenMetaStoryIds: ["ms-1"],
        },
        { classifyFn: async () => { classifyCalled = true; return { material: true }; } }
      );
      assert.equal(result.state, "unchanged");
      assert.equal(result.diagnostics.classifySkipped, true);
      assert.equal(classifyCalled, false, "DELTA_ENABLED=false must override classifyFn stub");
    }
  );
});

test("spec §10 row 12 — classify:true + write returns hallucinated outlet → state:'unchanged' + llmFailed.hallucination", async () => {
  const prior = story({
    metaStoryId: "ms-1",
    sources: [src("src-1", "Reuters", "A")],
  });
  const current = story({
    metaStoryId: "ms-1",
    sources: [src("src-1", "Reuters", "A"), src("src-2", "NYT", "B")],
  });
  const result = await resolveWhatChanged(
    {
      metaStoryId: "ms-1",
      currentStory: current,
      priorStory: prior,
      everSeenMetaStoryIds: ["ms-1"],
    },
    {
      config: enabledConfig(),
      classifyFn: async () => ({ material: true, confidence: 0.9, reasonCode: "new_outlet" }),
      // Bloomberg is NOT in either prior or current sources → hallucination guard trips.
      writeFn: async () => "Bloomberg expanded coverage with a new exclusive.",
    }
  );
  assert.equal(result.state, "unchanged");
  assert.equal(result.whatChanged, WHAT_CHANGED_COPY.unchanged);
  assert.equal(result.diagnostics.writeCalled, true);
  assert.equal(result.diagnostics.writeOk, false);
  assert.equal(result.diagnostics.llmFailed.hallucination, true);
  assert.equal(result.diagnostics.llmFailed.write, false, "hallucination is a distinct failure mode");
});

// ── Async orchestrator early branches (regression coverage) ─────────────────

test("resolveWhatChanged: first-seen short-circuits before any LLM stub runs", async () => {
  let classifyCalled = false;
  const result = await resolveWhatChanged(
    {
      metaStoryId: "ms-new",
      currentStory: story({ metaStoryId: "ms-new" }),
      priorStory: null,
      everSeenMetaStoryIds: ["ms-1"],
    },
    {
      config: enabledConfig(),
      classifyFn: async () => { classifyCalled = true; return { material: true }; },
    }
  );
  assert.equal(result.state, "first-seen");
  assert.equal(result.whatChanged, WHAT_CHANGED_COPY.firstSeen);
  assert.equal(result.diagnostics.classifySkipped, true);
  assert.equal(classifyCalled, false);
});

test("resolveWhatChanged: re-entry (ever-seen + no priorStory) → unchanged + classifySkipped", async () => {
  const result = await resolveWhatChanged(
    {
      metaStoryId: "ms-1",
      currentStory: story({ metaStoryId: "ms-1" }),
      priorStory: null,
      everSeenMetaStoryIds: ["ms-1"],
    },
    { config: enabledConfig(), classifyFn: async () => ({ material: true }) }
  );
  assert.equal(result.state, "unchanged");
  assert.equal(result.gate.signal, "none");
  assert.deepEqual(result.gate.reasons, ["no_prior_story"]);
  assert.equal(result.diagnostics.classifySkipped, true);
});

test("resolveWhatChanged: gate:'none' (reorder only) → unchanged + classifySkipped, no LLM call", async () => {
  let classifyCalled = false;
  const prior = story({ metaStoryId: "ms-1", sources: [src("src-1", "Reuters", "A"), src("src-2", "NYT", "B")] });
  const current = story({ metaStoryId: "ms-1", sources: [src("src-2", "NYT", "B"), src("src-1", "Reuters", "A")] });
  const result = await resolveWhatChanged(
    { metaStoryId: "ms-1", currentStory: current, priorStory: prior, everSeenMetaStoryIds: ["ms-1"] },
    { config: enabledConfig(), classifyFn: async () => { classifyCalled = true; return { material: true }; } }
  );
  assert.equal(result.state, "unchanged");
  assert.equal(result.gate.signal, "none");
  assert.equal(result.diagnostics.classifySkipped, true);
  assert.equal(classifyCalled, false);
});
