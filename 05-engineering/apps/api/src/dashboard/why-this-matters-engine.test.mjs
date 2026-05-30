import { test } from "node:test";
import assert from "node:assert/strict";

import {
  WHY_FALLBACK_COPY,
  WHY_IT_MATTERS_PROMPT_VERSION,
  WHY_IT_MATTERS_WRITER_VERSION,
  WHY_STATES,
  WHY_TAXONOMY,
  deriveWhyStateFromWhatChangedState,
  resolveWhyConfig,
  resolveWhyConcurrencyConfig,
  resolveWhyItMatters,
  safeWhyFallbackForState,
  validateWhyItMatters,
} from "./why-this-matters-engine.mjs";

// ─── env helper ─────────────────────────────────────────────────────────────

function withWhyEnv(setup, run) {
  const saved = {
    enabled: process.env.TEMPO_AI_WHY_IT_MATTERS_ENABLED,
    model: process.env.TEMPO_AI_WHY_IT_MATTERS_MODEL,
    timeout: process.env.TEMPO_AI_WHY_IT_MATTERS_TIMEOUT_MS,
    concurrency: process.env.TEMPO_AI_WHY_IT_MATTERS_CONCURRENCY,
    mockOnly: process.env.TEMPO_AI_MOCK_ONLY,
    apiKey: process.env.TEMPO_ANTHROPIC_API_KEY,
    altKey: process.env.ANTHROPIC_API_KEY,
  };
  delete process.env.TEMPO_AI_WHY_IT_MATTERS_ENABLED;
  delete process.env.TEMPO_AI_WHY_IT_MATTERS_MODEL;
  delete process.env.TEMPO_AI_WHY_IT_MATTERS_TIMEOUT_MS;
  delete process.env.TEMPO_AI_WHY_IT_MATTERS_CONCURRENCY;
  delete process.env.TEMPO_AI_MOCK_ONLY;
  delete process.env.TEMPO_ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  setup();
  const restore = () => {
    if (saved.enabled !== undefined) process.env.TEMPO_AI_WHY_IT_MATTERS_ENABLED = saved.enabled;
    if (saved.model !== undefined) process.env.TEMPO_AI_WHY_IT_MATTERS_MODEL = saved.model;
    if (saved.timeout !== undefined) process.env.TEMPO_AI_WHY_IT_MATTERS_TIMEOUT_MS = saved.timeout;
    if (saved.concurrency !== undefined) process.env.TEMPO_AI_WHY_IT_MATTERS_CONCURRENCY = saved.concurrency;
    if (saved.mockOnly !== undefined) process.env.TEMPO_AI_MOCK_ONLY = saved.mockOnly;
    if (saved.apiKey !== undefined) process.env.TEMPO_ANTHROPIC_API_KEY = saved.apiKey;
    if (saved.altKey !== undefined) process.env.ANTHROPIC_API_KEY = saved.altKey;
  };
  return Promise.resolve(run()).finally(restore);
}

// ─── deriveWhyStateFromWhatChangedState ─────────────────────────────────────

test("state mapping: firstSeen/unchanged/changed -> intro/steady/evolving", () => {
  assert.equal(deriveWhyStateFromWhatChangedState({ whatChangedState: "firstSeen" }), "intro");
  assert.equal(deriveWhyStateFromWhatChangedState({ whatChangedState: "unchanged" }), "steady");
  assert.equal(deriveWhyStateFromWhatChangedState({ whatChangedState: "changed" }), "evolving");
});

test("state mapping: unknown whatChangedState falls closed by everSeen", () => {
  // Not ever-seen -> intro; ever-seen -> steady (conservative; never invents evolving).
  assert.equal(deriveWhyStateFromWhatChangedState({ whatChangedState: null }), "intro");
  assert.equal(
    deriveWhyStateFromWhatChangedState({ whatChangedState: null, everSeen: true }),
    "steady"
  );
  assert.equal(
    deriveWhyStateFromWhatChangedState({ whatChangedState: undefined, everSeen: false }),
    "intro"
  );
  assert.equal(deriveWhyStateFromWhatChangedState({ whatChangedState: "weird" }), "intro");
});

// ─── safeWhyFallbackForState ────────────────────────────────────────────────

test("safe fallback returns Phase 3d copy for each state and defaults to steady", () => {
  assert.equal(safeWhyFallbackForState("intro"), WHY_FALLBACK_COPY.intro);
  assert.equal(safeWhyFallbackForState("steady"), WHY_FALLBACK_COPY.steady);
  assert.equal(safeWhyFallbackForState("evolving"), WHY_FALLBACK_COPY.evolving);
  assert.equal(safeWhyFallbackForState("bogus"), WHY_FALLBACK_COPY.steady);
  for (const state of WHY_STATES) {
    assert.ok(safeWhyFallbackForState(state).length > 0);
  }
});

// ─── resolveWhyConfig ───────────────────────────────────────────────────────

test("resolveWhyConfig: defaults — disabled, sonnet-4-6, 4000ms", async () => {
  await withWhyEnv(() => {}, () => {
    const cfg = resolveWhyConfig();
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.mockOnly, false);
    assert.equal(cfg.model, "anthropic:claude-sonnet-4-6");
    assert.equal(cfg.timeoutMs, 4000);
  });
});

test("resolveWhyConfig: TEMPO_AI_WHY_IT_MATTERS_ENABLED accepts true/1, rejects other", async () => {
  await withWhyEnv(() => { process.env.TEMPO_AI_WHY_IT_MATTERS_ENABLED = "true"; }, () => {
    assert.equal(resolveWhyConfig().enabled, true);
  });
  await withWhyEnv(() => { process.env.TEMPO_AI_WHY_IT_MATTERS_ENABLED = "1"; }, () => {
    assert.equal(resolveWhyConfig().enabled, true);
  });
  await withWhyEnv(() => { process.env.TEMPO_AI_WHY_IT_MATTERS_ENABLED = "TRUE"; }, () => {
    assert.equal(resolveWhyConfig().enabled, true);
  });
  await withWhyEnv(() => { process.env.TEMPO_AI_WHY_IT_MATTERS_ENABLED = "yes"; }, () => {
    assert.equal(resolveWhyConfig().enabled, false);
  });
});

test("resolveWhyConfig: TEMPO_AI_MOCK_ONLY=true vetoes the LLM path", async () => {
  await withWhyEnv(
    () => {
      process.env.TEMPO_AI_WHY_IT_MATTERS_ENABLED = "true";
      process.env.TEMPO_AI_MOCK_ONLY = "true";
    },
    () => {
      const cfg = resolveWhyConfig();
      assert.equal(cfg.enabled, false, "MOCK_ONLY must veto the LLM path (spec §11)");
      assert.equal(cfg.mockOnly, true);
    }
  );
});

test("resolveWhyConfig: env overrides for model + timeout", async () => {
  await withWhyEnv(
    () => {
      process.env.TEMPO_AI_WHY_IT_MATTERS_MODEL = "anthropic:claude-opus-4-7";
      process.env.TEMPO_AI_WHY_IT_MATTERS_TIMEOUT_MS = "1234";
    },
    () => {
      const cfg = resolveWhyConfig();
      assert.equal(cfg.model, "anthropic:claude-opus-4-7");
      assert.equal(cfg.timeoutMs, 1234);
    }
  );
});

test("resolveWhyConfig: invalid timeout falls back to default", async () => {
  await withWhyEnv(() => { process.env.TEMPO_AI_WHY_IT_MATTERS_TIMEOUT_MS = "not-a-number"; }, () => {
    assert.equal(resolveWhyConfig().timeoutMs, 4000);
  });
  await withWhyEnv(() => { process.env.TEMPO_AI_WHY_IT_MATTERS_TIMEOUT_MS = "-5"; }, () => {
    assert.equal(resolveWhyConfig().timeoutMs, 4000);
  });
});

// ─── resolveWhyConcurrencyConfig ────────────────────────────────────────────

test("resolveWhyConcurrencyConfig: unset → default 4", async () => {
  await withWhyEnv(() => {}, () => {
    assert.deepEqual(resolveWhyConcurrencyConfig(), { concurrency: 4 });
  });
});

test("resolveWhyConcurrencyConfig: exact in-range values pass through", async () => {
  await withWhyEnv(() => { process.env.TEMPO_AI_WHY_IT_MATTERS_CONCURRENCY = "4"; }, () => {
    assert.equal(resolveWhyConcurrencyConfig().concurrency, 4);
  });
  await withWhyEnv(() => { process.env.TEMPO_AI_WHY_IT_MATTERS_CONCURRENCY = "1"; }, () => {
    assert.equal(resolveWhyConcurrencyConfig().concurrency, 1);
  });
  await withWhyEnv(() => { process.env.TEMPO_AI_WHY_IT_MATTERS_CONCURRENCY = "6"; }, () => {
    assert.equal(resolveWhyConcurrencyConfig().concurrency, 6);
  });
});

test("resolveWhyConcurrencyConfig: below range clamps up to 1", async () => {
  await withWhyEnv(() => { process.env.TEMPO_AI_WHY_IT_MATTERS_CONCURRENCY = "0"; }, () => {
    assert.equal(resolveWhyConcurrencyConfig().concurrency, 1);
  });
  await withWhyEnv(() => { process.env.TEMPO_AI_WHY_IT_MATTERS_CONCURRENCY = "-1"; }, () => {
    assert.equal(resolveWhyConcurrencyConfig().concurrency, 1);
  });
});

test("resolveWhyConcurrencyConfig: above range clamps down to 6", async () => {
  await withWhyEnv(() => { process.env.TEMPO_AI_WHY_IT_MATTERS_CONCURRENCY = "7"; }, () => {
    assert.equal(resolveWhyConcurrencyConfig().concurrency, 6);
  });
  await withWhyEnv(() => { process.env.TEMPO_AI_WHY_IT_MATTERS_CONCURRENCY = "100"; }, () => {
    assert.equal(resolveWhyConcurrencyConfig().concurrency, 6);
  });
});

test("resolveWhyConcurrencyConfig: fractional value is truncated by parseInt before clamp ('2.9' → 2)", async () => {
  // parseInt stops at the decimal point, so "2.9" parses to 2 (not rounded to
  // 3) and then clamps within [1,6] unchanged.  Pins the documented truncation.
  await withWhyEnv(() => { process.env.TEMPO_AI_WHY_IT_MATTERS_CONCURRENCY = "2.9"; }, () => {
    assert.deepEqual(resolveWhyConcurrencyConfig(), { concurrency: 2 });
  });
});

test("resolveWhyConcurrencyConfig: invalid / empty falls back to default 4", async () => {
  await withWhyEnv(() => { process.env.TEMPO_AI_WHY_IT_MATTERS_CONCURRENCY = "abc"; }, () => {
    assert.equal(resolveWhyConcurrencyConfig().concurrency, 4);
  });
  await withWhyEnv(() => { process.env.TEMPO_AI_WHY_IT_MATTERS_CONCURRENCY = ""; }, () => {
    assert.equal(resolveWhyConcurrencyConfig().concurrency, 4);
  });
  await withWhyEnv(() => { process.env.TEMPO_AI_WHY_IT_MATTERS_CONCURRENCY = "   "; }, () => {
    assert.equal(resolveWhyConcurrencyConfig().concurrency, 4);
  });
});

// ─── validateWhyItMatters ───────────────────────────────────────────────────

const baselineGoldOutput = {
  text: "New on your watchlist — early pickup across outlets, so keep baseline monitoring, not background noise.",
  taxonomyPrimary: "monitoring_intensity",
  confidence: "medium",
};

const baselineGoldContext = {
  state: "intro",
  whatChangedState: "firstSeen",
  subtitle: "New cross-outlet pickup on a developing policy-to-political shift.",
  summary:
    "Coverage is beginning to frame possible sanctions implications and response pressure. The narrative is widening from policy reporting toward political reaction.",
  whatChanged: "First appearance in your feed.",
};

test("validator: golden intro/monitoring_intensity output passes all dimensions", () => {
  const result = validateWhyItMatters(baselineGoldOutput, baselineGoldContext);
  assert.equal(result.pass, true, `failReasons=${JSON.stringify(result.failReasons)}`);
  assert.equal(result.hardFail, false);
  assert.deepEqual(result.failReasons, []);
  // All eight dimensions present, all true.
  for (const dim of [
    "role_fit",
    "non_duplication",
    "non_prescriptive",
    "neutral_framing",
    "evidence_discipline",
    "length",
    "taxonomy_fit",
    "state_coherence",
  ]) {
    assert.equal(result.dimensionScores[dim], true, `dim=${dim}`);
  }
});

test("validator: directive trap fails non_prescriptive and flags hardFail (auto-fail phrase)", () => {
  const result = validateWhyItMatters(
    {
      text: "Issue a statement now before narrative hardens.",
      taxonomyPrimary: "coordination_pressure",
      confidence: "medium",
    },
    {
      state: "evolving",
      whatChangedState: "changed",
      subtitle: "Political reaction builds after a bilateral policy announcement.",
      summary: "Coverage is shifting toward political reaction.",
      whatChanged: "Political-framing headlines increased in the last cycle.",
    }
  );
  assert.equal(result.pass, false);
  assert.equal(result.hardFail, true);
  assert.ok(result.failReasons.includes("non_prescriptive"));
  assert.ok(result.failReasons.includes("auto_fail_phrase"));
});

test("validator: side-taking trap fails neutral_framing and is hardFail", () => {
  const result = validateWhyItMatters(
    {
      text: "US outlets are framing this correctly; Colombian coverage is misleading.",
      taxonomyPrimary: "narrative_stability",
      confidence: "medium",
    },
    {
      state: "evolving",
      whatChangedState: "changed",
      subtitle: "US and regional outlets diverge on who owns the narrative.",
      summary: "US wire and opinion coverage frame the episode as policy enforcement success.",
      whatChanged: "Cross-market framing gap widened in the latest cycle.",
    }
  );
  assert.equal(result.pass, false);
  assert.equal(result.hardFail, true);
  assert.ok(result.failReasons.includes("neutral_framing"));
});

test("validator: duplication trap (substring of summary) fails non_duplication", () => {
  const summary =
    "Two outlets reported new legal-context framing this morning, with both emphasizing court scheduling and procedural next steps.";
  const result = validateWhyItMatters(
    {
      text: "Two outlets reported new legal-context framing this morning.",
      taxonomyPrimary: "narrative_stability",
      confidence: "medium",
    },
    {
      state: "evolving",
      whatChangedState: "changed",
      subtitle: "Courts coverage expands on the same procedural step.",
      summary,
      whatChanged: "Legal-context framing appeared in two additional outlets.",
    }
  );
  assert.equal(result.pass, false);
  assert.ok(result.failReasons.includes("non_duplication"));
});

test("validator: state mismatch (steady + 'Nothing to monitor here.') fails state_coherence and is hardFail", () => {
  const result = validateWhyItMatters(
    {
      text: "Nothing to monitor here.",
      taxonomyPrimary: "narrative_stability",
      confidence: "high",
    },
    {
      state: "steady",
      whatChangedState: "unchanged",
      subtitle: "Routine diplomatic mention with stable headline patterns.",
      summary: "Coverage continues along the same diplomatic-mention angle.",
      whatChanged: "No material update since your last refresh.",
    }
  );
  assert.equal(result.pass, false);
  assert.equal(result.hardFail, true);
  assert.ok(result.failReasons.includes("state_coherence"));
});

test("validator: length overflow (>300 chars) fails length", () => {
  const long = "A ".repeat(160) + "monitoring posture watchlist.";
  const result = validateWhyItMatters(
    { text: long, taxonomyPrimary: "monitoring_intensity", confidence: "medium" },
    { state: "intro", subtitle: "x", summary: "y", whatChanged: "z" }
  );
  assert.equal(result.pass, false);
  assert.ok(result.failReasons.includes("length"));
});

test("validator: invalid taxonomy fails taxonomy_fit", () => {
  const result = validateWhyItMatters(
    {
      text: "Keep monitoring posture steady — early signals only.",
      taxonomyPrimary: "not_a_real_category",
      confidence: "medium",
    },
    { state: "intro", subtitle: "x", summary: "y", whatChanged: "z" }
  );
  assert.equal(result.pass, false);
  assert.ok(result.failReasons.includes("taxonomy_fit"));
});

test("validator: invalid confidence value fails evidence_discipline (but not hardFail)", () => {
  const result = validateWhyItMatters(
    {
      text: "Keep monitoring posture steady — early signals only.",
      taxonomyPrimary: "monitoring_intensity",
      confidence: "moderate", // not in {high, medium, low}
    },
    { state: "intro", subtitle: "x", summary: "y", whatChanged: "z" }
  );
  assert.equal(result.pass, false);
  assert.ok(result.failReasons.includes("evidence_discipline"));
  // Soft fail: rewrite should still get a chance to recover.
  assert.equal(result.hardFail, false);
});

test("validator: missing confidence string fails evidence_discipline", () => {
  const result = validateWhyItMatters(
    {
      text: "Keep monitoring posture steady — early signals only.",
      taxonomyPrimary: "monitoring_intensity",
      // confidence omitted entirely
    },
    { state: "intro", subtitle: "x", summary: "y", whatChanged: "z" }
  );
  assert.equal(result.pass, false);
  assert.ok(result.failReasons.includes("evidence_discipline"));
});

test("validator: low-confidence + strong certainty wording fails evidence_discipline", () => {
  const result = validateWhyItMatters(
    {
      text: "You will definitely get media calls today; keep monitoring posture sharp.",
      taxonomyPrimary: "stakeholder_exposure",
      confidence: "low",
    },
    { state: "intro", subtitle: "x", summary: "y", whatChanged: "z" }
  );
  assert.equal(result.pass, false);
  assert.equal(result.hardFail, true);
  assert.ok(result.failReasons.includes("evidence_discipline"));
});

// ─── resolveWhyItMatters: kill-switch / fallback paths ──────────────────────

const sampleInput = {
  metaStoryId: "fixture-test-1",
  state: "intro",
  whatChangedState: "firstSeen",
  subtitle: "New cross-outlet pickup on a developing policy-to-political shift.",
  summary: "Coverage is beginning to frame possible sanctions implications.",
  whatChanged: "First appearance in your feed.",
  evidenceRefs: {
    summaryChars: 210,
    sourceCount: 4,
    uniqueOutletCount: 3,
    framingDivergence: "low",
    cadenceSignal: "accelerating",
  },
  doctrineSnippets: [{ id: "doctrine.posture.intro", body: "Baseline relevance, no escalation." }],
};

const FIXED_NOW = "2026-05-20T12:00:00.000Z";

function assertTraceShape(trace, { fallback_used }) {
  for (const key of [
    "metaStoryId",
    "state",
    "whatChangedState",
    "taxonomyPrimary",
    "confidence",
    "evidenceRefs",
    "doctrineRefs",
    "fallback_used",
    "writerVersion",
    "promptVersion",
    "generatedAt",
  ]) {
    assert.ok(Object.prototype.hasOwnProperty.call(trace, key), `trace missing field: ${key}`);
  }
  assert.equal(trace.fallback_used, fallback_used);
  assert.equal(trace.writerVersion, WHY_IT_MATTERS_WRITER_VERSION);
  assert.equal(trace.promptVersion, WHY_IT_MATTERS_PROMPT_VERSION);
  assert.equal(typeof trace.generatedAt, "string");
}

test("resolver: disabled (flag off) -> safe state fallback, no writer call", async () => {
  await withWhyEnv(() => {}, async () => {
    const result = await resolveWhyItMatters(sampleInput, { generatedAt: FIXED_NOW });
    assert.equal(result.whyItMatters, WHY_FALLBACK_COPY.intro);
    assert.equal(result.diagnostics.writerCalled, false);
    assert.equal(result.diagnostics.fallbackUsed, true);
    assert.equal(result.diagnostics.fallbackReason, "disabled");
    assertTraceShape(result.trace, { fallback_used: true });
    assert.equal(result.trace.state, "intro");
    assert.equal(result.trace.whatChangedState, "firstSeen");
    assert.equal(result.trace.taxonomyPrimary, "signal_uncertainty");
    assert.equal(result.trace.confidence, "low");
    assert.deepEqual(result.trace.doctrineRefs, ["doctrine.posture.intro"]);
  });
});

test("resolver: mock-only veto produces fallback with reason=mock_only", async () => {
  await withWhyEnv(
    () => {
      process.env.TEMPO_AI_WHY_IT_MATTERS_ENABLED = "true";
      process.env.TEMPO_AI_MOCK_ONLY = "true";
    },
    async () => {
      const writeFn = () => {
        throw new Error("writer must not be called in mock-only mode");
      };
      const result = await resolveWhyItMatters(sampleInput, {
        writeFn,
        generatedAt: FIXED_NOW,
      });
      assert.equal(result.whyItMatters, WHY_FALLBACK_COPY.intro);
      assert.equal(result.diagnostics.writerCalled, false);
      assert.equal(result.diagnostics.fallbackUsed, true);
      assert.equal(result.diagnostics.fallbackReason, "mock_only");
    }
  );
});

test("resolver: forceWriterFail=true routes to fallback without invoking writer", async () => {
  await withWhyEnv(() => { process.env.TEMPO_AI_WHY_IT_MATTERS_ENABLED = "true"; }, async () => {
    let writerCalls = 0;
    const writeFn = () => {
      writerCalls += 1;
      return { text: "irrelevant", taxonomyPrimary: "monitoring_intensity", confidence: "medium" };
    };
    const result = await resolveWhyItMatters(
      { ...sampleInput, state: "evolving", whatChangedState: "changed", forceWriterFail: true },
      { writeFn, generatedAt: FIXED_NOW }
    );
    assert.equal(writerCalls, 0, "writer must not be called under forceWriterFail");
    assert.equal(result.whyItMatters, WHY_FALLBACK_COPY.evolving);
    assert.equal(result.diagnostics.fallbackUsed, true);
    assert.equal(result.diagnostics.fallbackReason, "force_writer_fail");
    assert.deepEqual(result.diagnostics.validationFailReasons, ["forced"]);
    assertTraceShape(result.trace, { fallback_used: true });
    assert.equal(result.trace.taxonomyPrimary, "signal_uncertainty");
    assert.equal(result.trace.confidence, "low");
  });
});

// ─── resolver: happy path ───────────────────────────────────────────────────

test("resolver: writer-first pass — returns LLM text + trace with fallback_used=false", async () => {
  await withWhyEnv(() => { process.env.TEMPO_AI_WHY_IT_MATTERS_ENABLED = "true"; }, async () => {
    const writeFn = ({ mode }) => {
      assert.equal(mode, "initial");
      return {
        text: "New on your watchlist — early pickup across outlets, so keep baseline monitoring, not background noise.",
        taxonomyPrimary: "monitoring_intensity",
        confidence: "medium",
      };
    };
    const result = await resolveWhyItMatters(sampleInput, {
      writeFn,
      generatedAt: FIXED_NOW,
    });
    assert.equal(result.diagnostics.writerCalled, true);
    assert.equal(result.diagnostics.writerOk, true);
    assert.equal(result.diagnostics.rewriteCalled, false);
    assert.equal(result.diagnostics.fallbackUsed, false);
    assert.ok(result.whyItMatters.startsWith("New on your watchlist"));
    assertTraceShape(result.trace, { fallback_used: false });
    assert.equal(result.trace.taxonomyPrimary, "monitoring_intensity");
    assert.equal(result.trace.confidence, "medium");
    assert.equal(result.trace.metaStoryId, "fixture-test-1");
    assert.deepEqual(result.trace.doctrineRefs, ["doctrine.posture.intro"]);
    assert.equal(result.trace.generatedAt, FIXED_NOW);
  });
});

// ─── resolver: rewrite recovery ─────────────────────────────────────────────

test("resolver: validation fails -> rewrite recovers -> returns rewrite text", async () => {
  await withWhyEnv(() => { process.env.TEMPO_AI_WHY_IT_MATTERS_ENABLED = "true"; }, async () => {
    const writeFn = ({ mode }) => {
      if (mode === "initial") {
        // Trap: near-duplicate of summary (duplication failure).
        return {
          text: "Coverage is beginning to frame possible sanctions implications.",
          taxonomyPrimary: "monitoring_intensity",
          confidence: "medium",
        };
      }
      // mode === "rewrite": clean implication line.
      return {
        text: "New on your watchlist — early pickup across outlets, so keep baseline monitoring, not background noise.",
        taxonomyPrimary: "monitoring_intensity",
        confidence: "medium",
      };
    };
    const result = await resolveWhyItMatters(sampleInput, {
      writeFn,
      generatedAt: FIXED_NOW,
    });
    assert.equal(result.diagnostics.writerCalled, true);
    assert.equal(result.diagnostics.rewriteCalled, true);
    assert.equal(result.diagnostics.rewriteOk, true);
    assert.equal(result.diagnostics.fallbackUsed, false);
    assert.ok(result.diagnostics.validationFailReasons.includes("non_duplication"));
    assert.ok(result.whyItMatters.startsWith("New on your watchlist"));
    assertTraceShape(result.trace, { fallback_used: false });
  });
});

// ─── resolver: rewrite also fails -> safe fallback ──────────────────────────

test("resolver: both write and rewrite fail validation -> Phase 3d safe fallback", async () => {
  await withWhyEnv(() => { process.env.TEMPO_AI_WHY_IT_MATTERS_ENABLED = "true"; }, async () => {
    const writeFn = ({ mode }) => {
      // Both attempts trip the directive auto-fail trap.
      return {
        text: mode === "initial"
          ? "Issue a statement now before narrative hardens."
          : "Respond now and approve a statement immediately.",
        taxonomyPrimary: "coordination_pressure",
        confidence: "medium",
      };
    };
    const result = await resolveWhyItMatters(
      { ...sampleInput, state: "evolving", whatChangedState: "changed" },
      { writeFn, generatedAt: FIXED_NOW }
    );
    assert.equal(result.diagnostics.writerCalled, true);
    assert.equal(result.diagnostics.rewriteCalled, true);
    assert.equal(result.diagnostics.rewriteOk, false);
    assert.equal(result.diagnostics.fallbackUsed, true);
    assert.equal(result.diagnostics.fallbackReason, "rewrite_validation_failed");
    assert.equal(result.whyItMatters, WHY_FALLBACK_COPY.evolving);
    assertTraceShape(result.trace, { fallback_used: true });
    assert.equal(result.trace.taxonomyPrimary, "signal_uncertainty");
    assert.equal(result.trace.confidence, "low");
    // First-attempt failReasons should be retained.
    assert.ok(result.diagnostics.validationFailReasons.includes("non_prescriptive"));
  });
});

// ─── resolver: invalid confidence enum routes through rewrite ───────────────

test("resolver: writer returns invalid confidence -> rewrite invoked; both bad -> fallback", async () => {
  await withWhyEnv(() => { process.env.TEMPO_AI_WHY_IT_MATTERS_ENABLED = "true"; }, async () => {
    const attempts = [];
    const writeFn = ({ mode }) => {
      attempts.push(mode);
      return {
        text: "New on your watchlist — early pickup across outlets, so keep baseline monitoring, not background noise.",
        taxonomyPrimary: "monitoring_intensity",
        // Both initial and rewrite return an out-of-enum confidence.
        confidence: mode === "initial" ? "moderate" : "uncertain",
      };
    };
    const result = await resolveWhyItMatters(sampleInput, {
      writeFn,
      generatedAt: FIXED_NOW,
    });
    assert.deepEqual(attempts, ["initial", "rewrite"]);
    assert.equal(result.diagnostics.fallbackUsed, true);
    assert.equal(result.diagnostics.fallbackReason, "rewrite_validation_failed");
    assert.ok(result.diagnostics.validationFailReasons.includes("evidence_discipline"));
    assert.equal(result.whyItMatters, WHY_FALLBACK_COPY.intro);
  });
});

test("resolver: writer returns invalid confidence -> rewrite fixes it -> success", async () => {
  await withWhyEnv(() => { process.env.TEMPO_AI_WHY_IT_MATTERS_ENABLED = "true"; }, async () => {
    const writeFn = ({ mode }) => ({
      text: "New on your watchlist — early pickup across outlets, so keep baseline monitoring, not background noise.",
      taxonomyPrimary: "monitoring_intensity",
      confidence: mode === "initial" ? "moderate" : "medium",
    });
    const result = await resolveWhyItMatters(sampleInput, {
      writeFn,
      generatedAt: FIXED_NOW,
    });
    assert.equal(result.diagnostics.rewriteOk, true);
    assert.equal(result.diagnostics.fallbackUsed, false);
    assert.equal(result.trace.confidence, "medium");
    assert.ok(result.diagnostics.validationFailReasons.includes("evidence_discipline"));
  });
});

// ─── resolver: writeFn throws -> fallback ───────────────────────────────────

test("resolver: writer throws -> safe fallback with llmFailed.write", async () => {
  await withWhyEnv(() => { process.env.TEMPO_AI_WHY_IT_MATTERS_ENABLED = "true"; }, async () => {
    const writeFn = () => {
      throw new Error("simulated provider failure");
    };
    const result = await resolveWhyItMatters(
      { ...sampleInput, state: "steady", whatChangedState: "unchanged" },
      { writeFn, generatedAt: FIXED_NOW }
    );
    assert.equal(result.whyItMatters, WHY_FALLBACK_COPY.steady);
    assert.equal(result.diagnostics.fallbackUsed, true);
    assert.equal(result.diagnostics.llmFailed.write, true);
    assertTraceShape(result.trace, { fallback_used: true });
  });
});

// ─── trace required fields exhaustive check ─────────────────────────────────

test("trace shape: all required fields present on both success and fallback paths", async () => {
  await withWhyEnv(() => { process.env.TEMPO_AI_WHY_IT_MATTERS_ENABLED = "true"; }, async () => {
    const passOutput = {
      text: "New on your watchlist — early pickup across outlets, so keep baseline monitoring, not background noise.",
      taxonomyPrimary: "monitoring_intensity",
      confidence: "medium",
    };
    const pass = await resolveWhyItMatters(sampleInput, {
      writeFn: () => passOutput,
      generatedAt: FIXED_NOW,
    });
    assertTraceShape(pass.trace, { fallback_used: false });

    const fail = await resolveWhyItMatters(
      { ...sampleInput, forceWriterFail: true },
      { generatedAt: FIXED_NOW }
    );
    assertTraceShape(fail.trace, { fallback_used: true });
  });
});

// ─── output shape sanity: taxonomy / states constants ───────────────────────

test("constants: WHY_TAXONOMY contains the six MVP categories", () => {
  assert.deepEqual(
    WHY_TAXONOMY.slice().sort(),
    [
      "coordination_pressure",
      "monitoring_intensity",
      "narrative_stability",
      "readiness_urgency",
      "signal_uncertainty",
      "stakeholder_exposure",
    ]
  );
});

test("constants: WHY_STATES = intro/steady/evolving", () => {
  assert.deepEqual(WHY_STATES.slice().sort(), ["evolving", "intro", "steady"]);
});

// ─── Slice 15: writer grounding bundle carries English translated evidence ───
//
// The why-this-matters writer grounds on the meta-story `summary` + `whatChanged`
// (+ structural `evidenceRefs`) — NOT raw source text. For a Spanish-sourced
// story those upstream fields are already English (clustering English-output
// guardrail + whatChanged normalized-EN evidence bundle, Slice 15). This pins
// that the writer input the engine assembles is English, with no Spanish leak.
test("resolver: writer input bundle carries English summary + whatChanged for a Spanish-sourced story", async () => {
  await withWhyEnv(() => { process.env.TEMPO_AI_WHY_IT_MATTERS_ENABLED = "true"; }, async () => {
    let captured = null;
    const writeFn = (payload) => {
      captured = payload;
      return {
        text: "Early multi-outlet pickup on border migration — hold baseline monitoring, not escalation.",
        taxonomyPrimary: "monitoring_intensity",
        confidence: "medium",
      };
    };
    const englishInput = {
      ...sampleInput,
      metaStoryId: "es-why-1",
      state: "evolving",
      whatChangedState: "changed",
      // English meta-story copy derived from translated Spanish sources.
      summary: "Authorities report a sustained increase in migration along the northern border.",
      whatChanged: "Two outlets added coverage of the migration increase.",
    };
    await resolveWhyItMatters(englishInput, { writeFn, generatedAt: FIXED_NOW });

    assert.ok(captured, "writer must be invoked with a grounding payload");
    assert.equal(
      captured.summary,
      "Authorities report a sustained increase in migration along the northern border."
    );
    assert.equal(captured.whatChanged, "Two outlets added coverage of the migration increase.");
    // No Spanish evidence leaks into the writer grounding bundle.
    assert.doesNotMatch(`${captured.summary} ${captured.whatChanged}`, /migraci[oó]n|frontera|aumento/i);
  });
});
