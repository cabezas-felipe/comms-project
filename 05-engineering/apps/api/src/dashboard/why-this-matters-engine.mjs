// Why-this-matters writer engine.
// Spec: docs/why-this-matters-spec.md (locked), prd: 03-prd/why-this-matters--strategy-spec.md.
//
// Two surfaces:
//   1. Deterministic helpers and a rubric validator that are pure / sync — no
//      network, no env reads.  `validateWhyItMatters`, `safeWhyFallbackForState`,
//      and `deriveWhyStateFromWhatChangedState` are always available.
//   2. Async `resolveWhyItMatters` orchestrator: write -> validate -> one
//      rewrite -> safe fallback.
//
// Product posture (spec §6, §9): LLM-first.  In normal prototype/prod
// configuration, `bootstrapApiEnv()` in server.mjs defaults
// `TEMPO_AI_WHY_IT_MATTERS_ENABLED=true` so every refresh produces tailored
// implications copy from the writer.  The deterministic Phase 3d state
// template is the **fallback / kill-switch** path, not the default
// experience.  Operator rollback is `TEMPO_AI_WHY_IT_MATTERS_ENABLED=false`;
// `TEMPO_AI_MOCK_ONLY=true` is treated as an LLM failure and also routes to
// the template (CI safety, no LLM spend).
//
// Trust posture (spec §1): never ship subtitle echo; never invent directives,
// side-taking, or strong-certainty implications.  When in doubt, fall back to
// the deterministic state copy and flag `fallback_used: true` on the trace.

import Anthropic from "@anthropic-ai/sdk";

import { providerFor } from "../ai/model-router.mjs";
import { withTimeout } from "../ai/guardrails.mjs";

export const WHY_IT_MATTERS_WRITER_VERSION = "why-it-matters-v0";
export const WHY_IT_MATTERS_PROMPT_VERSION = "why-it-matters-prompt-v4";

export const WHY_TAXONOMY = Object.freeze([
  "monitoring_intensity",
  "narrative_stability",
  "stakeholder_exposure",
  "coordination_pressure",
  "readiness_urgency",
  "signal_uncertainty",
]);
export const WHY_TAXONOMY_SET = new Set(WHY_TAXONOMY);

export const WHY_CONFIDENCE_LEVELS = Object.freeze(["high", "medium", "low"]);
export const WHY_CONFIDENCE_SET = new Set(WHY_CONFIDENCE_LEVELS);

export const WHY_STATES = Object.freeze(["intro", "steady", "evolving"]);
export const WHY_STATE_SET = new Set(WHY_STATES);

// Phase 3d safe-fallback templates (strategy §3d).  These ship verbatim when
// the writer is disabled, mock-only, errors out, or fails validation twice.
export const WHY_FALLBACK_COPY = Object.freeze({
  intro:
    "This narrative is newly entering your monitoring set; treat initial signals as baseline context before stronger implications.",
  steady:
    "No material shift detected since your last check; maintain standard monitoring posture for now.",
  evolving:
    "Recent movement suggests monitoring posture may need adjustment, though confidence remains limited by current evidence spread.",
});

export const MAX_WHY_CHARS = 300;
export const MAX_WHY_SENTENCES = 2;

const DEFAULT_WHY_MODEL = "anthropic:claude-sonnet-4-6";
const DEFAULT_WHY_TIMEOUT_MS = 4000;
const WHY_ENABLED_TRUTHY = new Set(["true", "1"]);

// Concurrency bounds for the (Slice 6) parallel why-it-matters loop.  Default
// 4 balances throughput against per-refresh LLM fan-out; the 1–6 clamp keeps a
// misconfigured override from either serializing needlessly (below 1) or
// stampeding the provider (above 6).
const DEFAULT_WHY_CONCURRENCY = 4;
const MIN_WHY_CONCURRENCY = 1;
const MAX_WHY_CONCURRENCY = 6;

// ── Config ──────────────────────────────────────────────────────────────────

/**
 * Resolve `TEMPO_AI_WHY_IT_MATTERS_*` env vars at call time.  `enabled` is the
 * conjunction of the feature flag being truthy AND `TEMPO_AI_MOCK_ONLY !==
 * "true"` (spec §9, §11): mock-only CI must never spend LLM calls on
 * implications copy.
 *
 * @returns {{
 *   enabled: boolean,
 *   mockOnly: boolean,
 *   model: string,
 *   timeoutMs: number,
 * }}
 */
export function resolveWhyConfig() {
  const enabledRaw = String(process.env.TEMPO_AI_WHY_IT_MATTERS_ENABLED ?? "").trim().toLowerCase();
  const mockOnly = String(process.env.TEMPO_AI_MOCK_ONLY ?? "").trim().toLowerCase() === "true";
  const model = (process.env.TEMPO_AI_WHY_IT_MATTERS_MODEL ?? "").trim() || DEFAULT_WHY_MODEL;
  const timeoutRaw = Number(process.env.TEMPO_AI_WHY_IT_MATTERS_TIMEOUT_MS);
  const timeoutMs =
    Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : DEFAULT_WHY_TIMEOUT_MS;
  return {
    enabled: WHY_ENABLED_TRUTHY.has(enabledRaw) && !mockOnly,
    mockOnly,
    model,
    timeoutMs,
  };
}

/**
 * Resolve the why-it-matters fan-out concurrency from
 * `TEMPO_AI_WHY_IT_MATTERS_CONCURRENCY` at call time (same env-read posture as
 * `resolveWhyConfig` — no caching, so tests can flip env between calls).
 *
 * Rules:
 *   - unset / empty / non-numeric (e.g. "abc") → default 4.
 *   - parsed integer below 1 (e.g. "0", "-1") → clamped up to 1.
 *   - parsed integer above 6 (e.g. "7", "100") → clamped down to 6.
 *   - fractional values are truncated toward zero before clamping ("2.9" → 2).
 *
 * Kept as a separate resolver (not merged into `resolveWhyConfig`) so Slice 6
 * can log it independently; the return shape is intentionally minimal.
 *
 * @returns {{ concurrency: number }}
 */
export function resolveWhyConcurrencyConfig() {
  const raw = String(process.env.TEMPO_AI_WHY_IT_MATTERS_CONCURRENCY ?? "").trim();
  const parsed = Number.parseInt(raw, 10);
  // Unparseable / empty falls back to the default; a valid number then clamps
  // into the [1, 6] band.
  const base = Number.isNaN(parsed) ? DEFAULT_WHY_CONCURRENCY : parsed;
  const concurrency = Math.max(MIN_WHY_CONCURRENCY, Math.min(MAX_WHY_CONCURRENCY, base));
  return { concurrency };
}

// ── State derivation ────────────────────────────────────────────────────────

/**
 * Derive the implications-engine `state` from a whatChanged enum (spec §3).
 *
 *   firstSeen  -> intro
 *   unchanged  -> steady
 *   changed    -> evolving
 *
 * Fail-closed mapping when `whatChangedState` is null/undefined/unknown:
 *   - not ever-seen -> intro
 *   - ever-seen      -> steady (conservative default — do not infer evolving)
 *
 * @param {{ whatChangedState: ("firstSeen"|"unchanged"|"changed"|null|undefined), everSeen?: boolean }} input
 * @returns {"intro" | "steady" | "evolving"}
 */
export function deriveWhyStateFromWhatChangedState({ whatChangedState, everSeen } = {}) {
  if (whatChangedState === "firstSeen") return "intro";
  if (whatChangedState === "unchanged") return "steady";
  if (whatChangedState === "changed") return "evolving";
  return everSeen ? "steady" : "intro";
}

/**
 * Phase 3d state-aware safe-fallback template (strategy §3d).  Always
 * returns a non-empty string; unknown states default to `steady`.
 *
 * @param {"intro" | "steady" | "evolving" | string} state
 * @returns {string}
 */
export function safeWhyFallbackForState(state) {
  if (state === "intro" || state === "steady" || state === "evolving") {
    return WHY_FALLBACK_COPY[state];
  }
  return WHY_FALLBACK_COPY.steady;
}

// ── Validator ───────────────────────────────────────────────────────────────
//
// Phase 4a/5a deterministic rubric.  Auto-fail phrase list lifted from
// strategy §4a; directive / side-taking / strong-certainty / hype patterns
// expanded so the validator catches near-paraphrases without depending on
// the model to self-report failure.

const AUTO_FAIL_PHRASES = Object.freeze([
  "respond now",
  "issue a statement",
  "must meet immediately",
  "definitely will",
  "chaos",
  "huge story",
]);

const DIRECTIVE_PATTERNS = Object.freeze([
  /\brespond\s+now\b/i,
  /\bissue\s+(?:a|an|the|your)?\s*statement\b/i,
  /\b(?:must|need\s+to|have\s+to)\s+(?:respond|meet|act|escalate|approve|publish|send|release|issue)\b/i,
  /\b(?:approve|push|release)\s+(?:a|an|the|your)?\s*(?:statement|response|message|brief|release)\b/i,
  /\bbefore\s+(?:it'?s?\s+)?too\s+late\b/i,
  /\bdo\s+(?:so|this|that|x)?\s+now\b/i,
]);

const SIDE_TAKING_PATTERNS = Object.freeze([
  // Generic "US/Colombian outlets/coverage are framing this correctly/wrongly".
  /\b(?:us|american|colombian?|colombia)\s+(?:outlets?|coverage|media|press|wires?)\s+(?:are|is)?\s*(?:framing|reporting|covering)?\s*(?:this\s+)?(?:correctly|properly|wrongly|biased(?:ly)?|misleading(?:ly)?)\b/i,
  /\b(?:us|american|colombian?|colombia)\s+(?:outlets?|coverage|media|press|wires?)\s+(?:are|is)\s+(?:misleading|biased|wrong|correct)\b/i,
  /\b(?:colombia|colombian)\s+coverage\s+is\s+misleading\b/i,
  /\b(?:us|american)\s+outlets?\s+are\s+framing\s+this\s+correctly\b/i,
]);

const STRONG_CERTAINTY_PATTERNS = Object.freeze([
  /\bwill\s+definitely\b/i,
  /\bdefinitely\s+will\b/i,
  /\bguarantee/i,
  /\bcertain(?:ly)?\b/i,
  /\bno\s+doubt\b/i,
  /\bundoubtedly\b/i,
]);

const HYPE_PATTERNS = Object.freeze([
  /\bchaos\b/i,
  /\bhuge\s+story\b/i,
  /\bout\s+of\s+control\b/i,
  /\bblowing\s+up\b/i,
]);

// Words/phrases that signal posture / readiness vocabulary.  Used by
// role_fit: an implication line should reach for at least one of these,
// otherwise it likely reads as recap or opinion.  Generous on purpose —
// false positives here would silently fall back to the safe template, so
// the cost of leniency is a slightly noisier writer pass, while the cost
// of strictness is hidden fallbacks.
const POSTURE_VOCAB_PATTERNS = Object.freeze([
  /\bmonitor/i,
  /\bwatch/i,
  /\bposture\b/i,
  /\breadiness\b/i,
  /\bprepare/i,
  /\bstay\b/i,
  /\bkeep\b/i,
  /\bexpect/i,
  /\bsuggest/i,
  /\bindicat/i,
  /\bsignal/i,
  /\bimplicat/i,
  /\bexposure\b/i,
  /\balignment\b/i,
  /\bpressure\b/i,
  /\bescalat/i,
  /\bcoordinat/i,
  /\bbaseline\b/i,
  /\battention\b/i,
  /\bcycle\b/i,
  /\banticipat/i,
  /\btentative/i,
  /\bconfidence\b/i,
  /\bbroaden/i,
  /\btreat\b/i,
  /\bstill\b/i,
  /\b(?:no|without|limited)\s+(?:material\s+)?(?:shift|movement|change)/i,
  /\bremain/i,
  /\bcheck\b/i,
  /\bsteady\b/i,
  /\bstable\b/i,
  /\bconsistent\b/i,
  /\bpredict/i,
  /\b(?:drop|rise|hold|widen|narrow|increase|decrease|grow|spread|shift|drift)/i,
  /\bmay\b/i,
  /\bcould\b/i,
  /\bearly\b/i,
]);

function hasPostureVocab(text) {
  return POSTURE_VOCAB_PATTERNS.some((re) => re.test(text));
}

function normalizeForCompare(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function tokenize(value) {
  return normalizeForCompare(value)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2);
}

// Substring + token-Jaccard dual gate.  Substring catches near-verbatim
// recap; Jaccard catches paraphrase duplication where wording drifts but
// the same content appears.  Both are deliberately conservative — we only
// reject when the overlap is high enough that a reader couldn't reasonably
// distinguish the two lines.
function isNearDuplicate(a, b) {
  const na = normalizeForCompare(a);
  const nb = normalizeForCompare(b);
  if (na.length === 0 || nb.length === 0) return false;
  if (na === nb) return true;
  if (na.length >= 30 && nb.includes(na)) return true;
  if (nb.length >= 30 && na.includes(nb)) return true;
  const toksA = new Set(tokenize(a));
  const toksB = new Set(tokenize(b));
  if (toksA.size < 4 || toksB.size < 4) return false;
  let intersect = 0;
  for (const t of toksA) if (toksB.has(t)) intersect += 1;
  const union = toksA.size + toksB.size - intersect;
  if (union === 0) return false;
  const jaccard = intersect / union;
  if (jaccard >= 0.7) return true;
  // If A is a short paraphrase fully covered by B's vocabulary, treat as
  // duplication even when union is large (covers "trap is summary subset").
  if (toksA.size <= toksB.size && intersect / toksA.size >= 0.85) return true;
  return false;
}

function countSentences(text) {
  const matches = String(text ?? "").match(/[^.!?]+[.!?]+/g);
  if (!matches || matches.length === 0) return text.trim().length > 0 ? 1 : 0;
  // Tail with no terminator → still counts as one extra sentence.
  const joined = matches.join("").trim();
  const tail = text.trim().slice(joined.length).trim();
  return matches.length + (tail.length > 0 ? 1 : 0);
}

function checkLength(text) {
  if (typeof text !== "string") return false;
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.length > MAX_WHY_CHARS) return false;
  const sentences = countSentences(trimmed);
  if (sentences < 1 || sentences > MAX_WHY_SENTENCES) return false;
  return true;
}

function checkStateCoherence(text, state) {
  const lower = String(text ?? "").toLowerCase();
  if (state === "steady") {
    // Nihilistic "nothing to monitor" contradicts steady intent
    // (steady = ongoing relevance, not absence of relevance).
    if (/\bnothing\s+to\s+monitor\b/.test(lower)) return false;
    // Strong adjectival movement assertions.  "fresh" is excluded because
    // the goldens routinely negate it ("without fresh movement").
    if (
      /\b(?:major|rapid|sharp|dramatic)\s+(?:shift|movement|escalation|acceleration|surge|swing)\b/
        .test(lower)
    ) {
      return false;
    }
    // Active positive movement verbs in present continuous (subject + is/are/now
    // + movement stem).  Bare nouns in negations like "no escalation warranted"
    // are intentionally allowed.
    if (
      /\b(?:is|are|now)\s+(?:shift|spread|drift|widen|escalat|accelerat|surg|breaking)/.test(lower)
    ) {
      return false;
    }
  }
  if (state === "evolving") {
    // Evolving must reflect movement, not deny it.
    if (/\bno\s+material\s+shift\b/.test(lower)) return false;
    if (/\bno\s+movement\b/.test(lower)) return false;
    if (/\bnothing\s+(?:changed|happened|new)\b/.test(lower)) return false;
  }
  return true;
}

function hasAutoFailPhrase(text) {
  const lower = String(text ?? "").toLowerCase();
  for (const phrase of AUTO_FAIL_PHRASES) {
    if (lower.includes(phrase)) return true;
  }
  return false;
}

function hasHype(text) {
  return HYPE_PATTERNS.some((re) => re.test(text));
}

function hasDirective(text) {
  return DIRECTIVE_PATTERNS.some((re) => re.test(text));
}

function hasSideTaking(text) {
  return SIDE_TAKING_PATTERNS.some((re) => re.test(text));
}

function hasStrongCertainty(text) {
  return STRONG_CERTAINTY_PATTERNS.some((re) => re.test(text));
}

/**
 * Phase 4a/5a deterministic validator (strategy §4a + §5a).  Pure / sync —
 * no I/O.  Callers pass the writer output plus the context the writer saw
 * (subtitle, summary, whatChanged, state).
 *
 * Hard-fail dimensions (any of these failing forces `hardFail: true`):
 *   - non_prescriptive (directive tone / auto-fail directive phrase)
 *   - neutral_framing  (side-taking)
 *   - auto_fail_phrase (any strategy §4a auto-fail phrase, including hype)
 *   - state_coherence on steady (contradicts steady intent)
 *   - evidence_discipline (strong certainty with confidence=low)
 *
 * @param {{ text?: string, whyItMatters?: string, taxonomyPrimary?: string, confidence?: string }} output
 * @param {{
 *   state?: string,
 *   whatChangedState?: string|null,
 *   subtitle?: string,
 *   summary?: string,
 *   whatChanged?: string,
 *   evidenceRefs?: object,
 * }} context
 * @returns {{
 *   pass: boolean,
 *   hardFail: boolean,
 *   failReasons: string[],
 *   dimensionScores: Record<string, boolean>,
 * }}
 */
export function validateWhyItMatters(output, context) {
  const text = String(output?.text ?? output?.whyItMatters ?? "").trim();
  const taxonomyPrimary = typeof output?.taxonomyPrimary === "string" ? output.taxonomyPrimary : "";
  const confidence = typeof output?.confidence === "string" ? output.confidence : "";

  const state = typeof context?.state === "string" ? context.state : "steady";
  const subtitle = typeof context?.subtitle === "string" ? context.subtitle : "";
  const summary = typeof context?.summary === "string" ? context.summary : "";
  const whatChanged = typeof context?.whatChanged === "string" ? context.whatChanged : "";

  const failReasons = [];
  const dimensionScores = {};

  // 1. role_fit — posture/readiness vocabulary present, not pure recap.
  const roleFit = text.length > 0 && hasPostureVocab(text);
  dimensionScores.role_fit = roleFit;
  if (!roleFit) failReasons.push("role_fit");

  // 2. non_duplication — not a near-duplicate of subtitle, summary, or
  //    whatChanged.  Boundary tests from strategy §0b.
  const nonDup =
    !isNearDuplicate(text, subtitle) &&
    !isNearDuplicate(text, summary) &&
    !isNearDuplicate(text, whatChanged);
  dimensionScores.non_duplication = nonDup;
  if (!nonDup) failReasons.push("non_duplication");

  // 3. non_prescriptive — no directive tone.
  const directive = hasDirective(text);
  dimensionScores.non_prescriptive = !directive;
  if (directive) failReasons.push("non_prescriptive");

  // 4. neutral_framing — no side-taking.
  const sideTaking = hasSideTaking(text);
  dimensionScores.neutral_framing = !sideTaking;
  if (sideTaking) failReasons.push("neutral_framing");

  // 5. evidence_discipline — confidence must be one of the three allowed
  //    levels AND low-confidence outputs must not use strong certainty
  //    verbs.  An unknown / out-of-enum confidence is treated as a
  //    discipline failure: without a calibration target we cannot verify
  //    the language-strength contract from strategy §5a.
  const confidenceValid = WHY_CONFIDENCE_SET.has(confidence);
  const strongCertaintyConflict = confidence === "low" && hasStrongCertainty(text);
  const evidenceOk = confidenceValid && !strongCertaintyConflict;
  dimensionScores.evidence_discipline = evidenceOk;
  if (!evidenceOk) failReasons.push("evidence_discipline");

  // 6. length — 1–2 sentences, <= MAX_WHY_CHARS chars.
  const lengthOk = checkLength(text);
  dimensionScores.length = lengthOk;
  if (!lengthOk) failReasons.push("length");

  // 7. taxonomy_fit — one of the six MVP categories.
  const taxonomyOk = WHY_TAXONOMY_SET.has(taxonomyPrimary);
  dimensionScores.taxonomy_fit = taxonomyOk;
  if (!taxonomyOk) failReasons.push("taxonomy_fit");

  // 8. state_coherence — matches intro/steady/evolving intent.
  const stateOk = checkStateCoherence(text, state);
  dimensionScores.state_coherence = stateOk;
  if (!stateOk) failReasons.push("state_coherence");

  // Auto-fail phrase / hype — recorded as separate fail reason and force
  // hardFail.  Some patterns also fire non_prescriptive ("respond now") so
  // we keep both reasons to make the failure source visible to operators.
  const autoFail = hasAutoFailPhrase(text);
  const hype = hasHype(text);
  if (autoFail || hype) failReasons.push("auto_fail_phrase");

  // hardFail mirrors strategy §5a "Hard-fail overrides".  An invalid
  // confidence enum still fails evidence_discipline (soft fail) so the
  // rewrite loop gets a chance to recover before falling back; a strong
  // certainty + low confidence conflict, by contrast, is hard.
  const hardFail =
    directive ||
    sideTaking ||
    autoFail ||
    hype ||
    strongCertaintyConflict ||
    (state === "steady" && !stateOk);

  return {
    pass: failReasons.length === 0,
    hardFail,
    failReasons,
    dimensionScores,
  };
}

// ── Prompt templates ────────────────────────────────────────────────────────

export const WHY_SYSTEM_PROMPT = [
  "You write the 'Why this matters' line for a comms / public-affairs professional dashboard.",
  "Each output is a monitoring-posture + comms-readiness implication for a meta-story cluster.",
  "",
  "You are NOT writing:",
  "- a recap of the underlying events (that lives in summary),",
  "- the user-relative delta (that lives in whatChanged),",
  "- a deck placement (that lives in subtitle),",
  "- a directive ('respond now', 'issue a statement', 'must meet immediately'),",
  "- a side-taking comparison between US and Colombian outlets or coverage.",
  "",
  "Workflow: pick taxonomyPrimary first from evidence + state using the disambiguation ladder below, then write the line so the prose expresses that category.",
  "",
  "Voice — peer briefing for a comms professional (not a policy memo or academic note):",
  "- Plain English, short sentences, one clear takeaway per line.",
  "- Lead with the implication. Use concrete verbs and observable coverage patterns (source spread, framing, cadence), not stacked abstract nouns or speculation.",
  "- Posture/readiness language only; never directive, never side-taking. Neutral bilateral framing.",
  "- Calibrate certainty to evidence strength: thin signal → 'may', 'suggest', 'early'; firmer wording only when source spread + framing support it.",
  "- Keep jargon light: at most one professional comms term per line. Common posture verbs (monitor, watch, expect, stay, prepare) don't count.",
  "- Em dashes are rare — at most one per output, only if it improves scanning.",
  "",
  "Anti-example (do NOT produce output shaped like this — stacked abstract nouns, two ideas crammed together):",
  "  'Single-outlet, low-divergence coverage suggests limited amplification so far; energy interdependence framing may attract broader pickup if deal status remains unresolved.'",
  "",
  "Tone anchors (match shape and density, not wording):",
  "- 'Coverage is still single-outlet, so reach stays narrow for now.'",
  "- 'Framing is consistent across outlets, which keeps the signal easier to track.'",
  "",
  "State emphasis (state is given to you — do not re-infer it):",
  "- intro: baseline relevance, no escalation alarm.",
  "- steady: ongoing relevance without implying fresh movement (no words like 'shift', 'escalation', 'acceleration', 'spreading').",
  "- evolving: implication shift tied to detected movement; do not re-report the delta line.",
  "",
  "Length and shape:",
  "- 1 to 2 sentences. Hard maximum of 300 characters.",
  "- Bias to ~120–180 characters when the takeaway is clear; shorter is better than padded.",
  "- Do not echo, paraphrase, or summarize the subtitle, summary, or whatChanged.",
  "",
  "Taxonomy disambiguation ladder — pick exactly one for taxonomyPrimary. Walk the ladder top to bottom and stop at the FIRST category that fits. narrative_stability is the last resort, not the default:",
  "- monitoring_intensity   — cadence is picking up, more outlets are joining, or pickup is widening. Trigger phrases: 'watch more closely', 'attention should sharpen', 'movement picked up'. Anti-trigger: framing is steady and volume is flat.",
  "- stakeholder_exposure   — inbound questions, media calls, or external/bilateral attention on the user is the likely next move. Trigger phrases: 'expect inbound', 'early interest before direction is clear', 'renewed bilateral attention'. Anti-trigger: no external party is implicated.",
  "- coordination_pressure  — cross-team or internal alignment pressure on messaging is implicated, especially when framing is shifting or hardening. Trigger phrases: 'alignment needs may rise', 'internal alignment pressure', 'before messaging hardens'. Anti-trigger: no team or messaging tension is implied.",
  "- readiness_urgency      — preparedness or timing posture is the takeaway, even when nothing fresh has moved. Trigger phrases: 'stay prepared', 'still in view, still relevant', 'maintain posture until movement is confirmed'. Anti-trigger: no readiness/timing implication.",
  "- signal_uncertainty     — evidence is too thin to commit to any other category (single outlet, ambiguous framing, very early signal). Trigger phrases: 'thin coverage', 'tentative', 'early and narrow', 'limited implication confidence'. Anti-trigger: source spread or framing is already readable.",
  "- narrative_stability    — choose this ONLY when framing is consistent across outlets AND none of the above signals (intensity, exposure, coordination, readiness, uncertainty) applies. Trigger phrases: 'framing still looks consistent', 'no escalation warranted', 'predictability is holding'. Anti-trigger: any cadence/exposure/alignment/readiness pressure is present.",
  "",
  "Tie-breakers when more than one category seems to fit (do not let monitoring_intensity greedily win whenever movement exists):",
  "- If the primary implication is inward-facing (stakeholder inbound likelihood, cross-team alignment pressure, or readiness/timing posture), prefer stakeholder_exposure / coordination_pressure / readiness_urgency over monitoring_intensity.",
  "- Pick monitoring_intensity only when 'watch closer' is genuinely the main takeaway — movement is necessary but not sufficient on its own.",
  "- When movement is present but its main implication is framing alignment or preparedness timing, choose coordination_pressure or readiness_urgency over monitoring_intensity.",
  "",
  "Boundary rules — disambiguate the three most-confused pairs:",
  "- narrative_stability vs coordination_pressure: choose narrative_stability when framing is consistent and no explicit internal alignment tension is evidenced; choose coordination_pressure only when cross-team or message-alignment pressure is clearly the primary implication.",
  "- monitoring_intensity vs stakeholder_exposure: choose monitoring_intensity when the main implication is watch-closer cadence or source-pickup; choose stakeholder_exposure only when likely inbound, media, or stakeholder questioning is explicit and primary.",
  "- readiness_urgency vs coordination_pressure: choose readiness_urgency for timing or preparedness posture ('stay prepared', 'be ready if...'); choose coordination_pressure only when alignment across teams or messages is the center of gravity.",
  "- Do not infer coordination_pressure from generic movement alone; it requires explicit alignment or messaging tension.",
  "",
  "Confidence (pick exactly one):",
  "- high   (broad source spread, low framing divergence, durable signal)",
  "- medium (mixed but readable signal)",
  "- low    (thin source spread, ambiguous framing, early or single-outlet movement)",
  "",
  "Output format: a single JSON object, no markdown, no prose around it.",
  '{"whyItMatters": "<1-2 sentences, <=300 chars>", "taxonomyPrimary": "<one of the six>", "confidence": "<high|medium|low>"}',
].join("\n");

function buildInitialUserPrompt(payload) {
  return [
    "Write the implications line for this meta-story.",
    "",
    "Inputs (do not echo any of these fields directly):",
    JSON.stringify(payload),
    "",
    "Reply with the JSON object only.",
  ].join("\n");
}

function buildRewriteUserPrompt(payload) {
  const reasons = Array.isArray(payload.failReasons) ? payload.failReasons : [];
  return [
    "Your previous attempt failed the rubric. Rewrite the implications line so every failed check passes.",
    "",
    "Priority: satisfy the rubric first; preserve voice second. If style guidance and the rubric conflict, satisfy the rubric.",
    "If failReasons includes 'taxonomy_fit' (or your previous taxonomy choice looks off given evidence + state), re-pick taxonomyPrimary from the disambiguation ladder FIRST, then regenerate the prose so it expresses that category.",
    "",
    "Failed checks to fix (address each one explicitly):",
    reasons.length > 0 ? reasons.map((r) => `- ${r}`).join("\n") : "- (unspecified)",
    "",
    "Previous attempt (do NOT repeat its problems):",
    JSON.stringify(payload.priorAttempt ?? ""),
    "",
    "Inputs:",
    JSON.stringify({
      metaStoryId: payload.metaStoryId,
      state: payload.state,
      whatChangedState: payload.whatChangedState,
      title: payload.title,
      subtitle: payload.subtitle,
      summary: payload.summary,
      whatChanged: payload.whatChanged,
      evidenceRefs: payload.evidenceRefs,
      doctrineSnippets: payload.doctrineSnippets,
    }),
    "",
    "Reply with the JSON object only.",
  ].join("\n");
}

// ── Writer plumbing ─────────────────────────────────────────────────────────

/** Test hook for the Sonnet call.  See `_deltaWriteClient` in what-changed-engine.mjs. */
export const _whyWriteClient = { create: null };

function resolveModelName(model) {
  const i = model.indexOf(":");
  return i !== -1 ? model.slice(i + 1) : model;
}

function buildWhyPayload(input) {
  const snippets = Array.isArray(input?.doctrineSnippets) ? input.doctrineSnippets : [];
  return {
    metaStoryId: typeof input?.metaStoryId === "string" ? input.metaStoryId : "",
    state: typeof input?.state === "string" ? input.state : "steady",
    whatChangedState: input?.whatChangedState ?? null,
    title: typeof input?.title === "string" ? input.title : "",
    subtitle: typeof input?.subtitle === "string" ? input.subtitle : "",
    summary: typeof input?.summary === "string" ? input.summary : "",
    whatChanged: typeof input?.whatChanged === "string" ? input.whatChanged : "",
    evidenceRefs: input?.evidenceRefs ?? {},
    doctrineSnippets: snippets
      .filter((s) => s && typeof s === "object")
      .map((s) => ({
        id: typeof s.id === "string" ? s.id : "",
        body: typeof s.body === "string" ? s.body : "",
      })),
  };
}

function parseWriterResponse(raw) {
  const clean = String(raw ?? "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  if (clean.length === 0) return { ok: false, reason: "empty_response" };
  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch {
    return { ok: false, reason: "parse_failed" };
  }
  if (!parsed || typeof parsed !== "object") return { ok: false, reason: "parse_failed" };
  const text = typeof parsed.whyItMatters === "string" ? parsed.whyItMatters.trim() : "";
  const taxonomyPrimary =
    typeof parsed.taxonomyPrimary === "string" ? parsed.taxonomyPrimary.trim() : "";
  const confidence = typeof parsed.confidence === "string" ? parsed.confidence.trim() : "";
  if (text.length === 0) return { ok: false, reason: "empty_text" };
  return { ok: true, text, taxonomyPrimary, confidence };
}

async function callAnthropicWriter(payload, opts) {
  const config = opts.config;
  const model = config.model;
  const provider = providerFor(model);
  const modelName = resolveModelName(model);
  const timeoutMs = config.timeoutMs;

  if (provider === "mock-anthropic" || provider === "mock-openai") {
    return { ok: false, reason: "mock_provider_skip" };
  }
  if (provider !== "anthropic") {
    return { ok: false, reason: `unsupported_provider:${provider}` };
  }
  const apiKey = process.env.TEMPO_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ok: false, reason: "missing_api_key" };

  const userPrompt =
    opts.mode === "rewrite" ? buildRewriteUserPrompt(payload) : buildInitialUserPrompt(payload);

  try {
    const raw = await withTimeout(
      async () => {
        const client = _whyWriteClient.create
          ? _whyWriteClient.create({ apiKey, timeoutMs })
          : new Anthropic({ apiKey, timeout: timeoutMs });
        const message = await client.messages.create({
          model: modelName,
          max_tokens: 400,
          temperature: 0.2,
          system: WHY_SYSTEM_PROMPT,
          messages: [{ role: "user", content: userPrompt }],
        });
        const block = message?.content?.[0];
        if (!block || block.type !== "text" || !block.text?.trim()) {
          throw new Error("Anthropic returned empty why-it-matters response");
        }
        return block.text;
      },
      timeoutMs,
      `Anthropic why-it-matters write timed out (${modelName})`
    );
    return parseWriterResponse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[why-it-matters.write] failed: ${msg}; fail-closed to fallback`);
    return { ok: false, reason: "write_failed", error: err };
  }
}

async function callWriter(payload, opts) {
  if (typeof opts.writeFn === "function") {
    try {
      const result = await opts.writeFn({ ...payload, mode: opts.mode });
      if (result && typeof result === "object" && typeof result.text === "string") {
        return {
          ok: true,
          text: result.text,
          taxonomyPrimary: typeof result.taxonomyPrimary === "string" ? result.taxonomyPrimary : "",
          confidence: typeof result.confidence === "string" ? result.confidence : "",
        };
      }
      return { ok: false, reason: "writeFn_returned_invalid" };
    } catch (err) {
      return { ok: false, reason: "writeFn_threw", error: err };
    }
  }
  return callAnthropicWriter(payload, opts);
}

// ── Resolver ────────────────────────────────────────────────────────────────

function emptyDiagnostics() {
  return {
    writerCalled: false,
    writerOk: false,
    rewriteCalled: false,
    rewriteOk: false,
    validationFailReasons: [],
    fallbackUsed: false,
    fallbackReason: null,
    llmFailed: { write: false, rewrite: false },
    latencyMs: { write: 0, rewrite: 0 },
  };
}

function buildTrace({
  metaStoryId,
  state,
  whatChangedState,
  taxonomyPrimary,
  confidence,
  evidenceRefs,
  doctrineRefs,
  fallbackUsed,
  generatedAt,
}) {
  return {
    metaStoryId,
    state,
    whatChangedState: whatChangedState ?? null,
    taxonomyPrimary,
    confidence,
    evidenceRefs: evidenceRefs ?? {},
    doctrineRefs: Array.isArray(doctrineRefs) ? doctrineRefs : [],
    fallback_used: fallbackUsed === true,
    writerVersion: WHY_IT_MATTERS_WRITER_VERSION,
    promptVersion: WHY_IT_MATTERS_PROMPT_VERSION,
    generatedAt,
  };
}

/**
 * Full resolver — the entry point the refresh pipeline will call per shipped
 * story.  Behavior (spec §6):
 *
 *   1. Compute `state` from input (or derive from whatChangedState + everSeen).
 *   2. If disabled (env off or mock-only) -> deterministic state fallback.
 *   3. If `input.forceWriterFail === true` -> deterministic fallback (eval-D03).
 *   4. Otherwise: write -> validate.  On pass, return the writer output.
 *   5. On fail: one rewrite with failReasons injected -> re-validate.  On
 *      pass, return.  On fail, deterministic state fallback.
 *   6. Any provider error / writer exception falls through to the same safe
 *      fallback (never empty, never directive, never side-taking).
 *
 * @param {{
 *   metaStoryId?: string,
 *   title?: string,
 *   subtitle?: string,
 *   summary?: string,
 *   whatChanged?: string,
 *   whatChangedState?: string|null,
 *   state?: string,
 *   everSeen?: boolean,
 *   evidenceRefs?: object,
 *   doctrineSnippets?: Array<{id: string, body?: string}>,
 *   forceWriterFail?: boolean,
 * }} input
 * @param {{
 *   config?: object,
 *   writeFn?: Function,
 *   generatedAt?: string,
 * }} [opts]
 */
export async function resolveWhyItMatters(input, opts = {}) {
  const config = opts.config ?? resolveWhyConfig();
  const generatedAt = typeof opts.generatedAt === "string" ? opts.generatedAt : new Date().toISOString();

  const whatChangedState = input?.whatChangedState ?? null;
  const everSeen = Boolean(input?.everSeen);
  const stateInput = typeof input?.state === "string" && WHY_STATE_SET.has(input.state) ? input.state : null;
  const state = stateInput ?? deriveWhyStateFromWhatChangedState({ whatChangedState, everSeen });

  const evidenceRefs = input?.evidenceRefs ?? {};
  const doctrineSnippets = Array.isArray(input?.doctrineSnippets) ? input.doctrineSnippets : [];
  const doctrineRefs = doctrineSnippets
    .map((s) => (s && typeof s.id === "string" ? s.id : ""))
    .filter((id) => id.length > 0);
  const metaStoryId = typeof input?.metaStoryId === "string" ? input.metaStoryId : "";

  const validationContext = {
    state,
    whatChangedState,
    subtitle: typeof input?.subtitle === "string" ? input.subtitle : "",
    summary: typeof input?.summary === "string" ? input.summary : "",
    whatChanged: typeof input?.whatChanged === "string" ? input.whatChanged : "",
    evidenceRefs,
  };

  const diagnostics = emptyDiagnostics();

  const makeFallback = (reason) => {
    diagnostics.fallbackUsed = true;
    diagnostics.fallbackReason = reason;
    return {
      whyItMatters: safeWhyFallbackForState(state),
      trace: buildTrace({
        metaStoryId,
        state,
        whatChangedState,
        taxonomyPrimary: "signal_uncertainty",
        confidence: "low",
        evidenceRefs,
        doctrineRefs,
        fallbackUsed: true,
        generatedAt,
      }),
      diagnostics,
    };
  };

  // Kill-switch paths: disabled flag, mock-only, or forced fail.
  if (!config.enabled) {
    return makeFallback(config.mockOnly ? "mock_only" : "disabled");
  }
  if (input?.forceWriterFail === true) {
    diagnostics.writerCalled = true;
    diagnostics.llmFailed.write = true;
    diagnostics.validationFailReasons = ["forced"];
    return makeFallback("force_writer_fail");
  }

  // ── Stage 1: write + validate ─────────────────────────────────────────────
  const writePayload = buildWhyPayload({ ...input, state, doctrineSnippets });
  diagnostics.writerCalled = true;
  const tWrite = Date.now();
  const writeResult = await callWriter(writePayload, { writeFn: opts.writeFn, config, mode: "initial" });
  diagnostics.latencyMs.write = Date.now() - tWrite;

  if (!writeResult.ok) {
    diagnostics.llmFailed.write = true;
    return makeFallback(writeResult.reason ?? "write_failed");
  }
  diagnostics.writerOk = true;

  const firstValidation = validateWhyItMatters(
    {
      text: writeResult.text,
      taxonomyPrimary: writeResult.taxonomyPrimary,
      confidence: writeResult.confidence,
    },
    validationContext
  );
  if (firstValidation.pass) {
    return {
      whyItMatters: writeResult.text,
      trace: buildTrace({
        metaStoryId,
        state,
        whatChangedState,
        taxonomyPrimary: writeResult.taxonomyPrimary,
        confidence: writeResult.confidence,
        evidenceRefs,
        doctrineRefs,
        fallbackUsed: false,
        generatedAt,
      }),
      diagnostics,
    };
  }
  diagnostics.validationFailReasons = firstValidation.failReasons.slice();

  // ── Stage 2: rewrite + validate ───────────────────────────────────────────
  const rewritePayload = {
    ...writePayload,
    failReasons: firstValidation.failReasons,
    priorAttempt: writeResult.text,
  };
  diagnostics.rewriteCalled = true;
  const tRewrite = Date.now();
  const rewriteResult = await callWriter(rewritePayload, {
    writeFn: opts.writeFn,
    config,
    mode: "rewrite",
  });
  diagnostics.latencyMs.rewrite = Date.now() - tRewrite;

  if (!rewriteResult.ok) {
    diagnostics.llmFailed.rewrite = true;
    return makeFallback(rewriteResult.reason ?? "rewrite_failed");
  }

  const secondValidation = validateWhyItMatters(
    {
      text: rewriteResult.text,
      taxonomyPrimary: rewriteResult.taxonomyPrimary,
      confidence: rewriteResult.confidence,
    },
    validationContext
  );
  if (secondValidation.pass) {
    diagnostics.rewriteOk = true;
    return {
      whyItMatters: rewriteResult.text,
      trace: buildTrace({
        metaStoryId,
        state,
        whatChangedState,
        taxonomyPrimary: rewriteResult.taxonomyPrimary,
        confidence: rewriteResult.confidence,
        evidenceRefs,
        doctrineRefs,
        fallbackUsed: false,
        generatedAt,
      }),
      diagnostics,
    };
  }

  diagnostics.validationFailReasons = [
    ...firstValidation.failReasons,
    ...secondValidation.failReasons,
  ];
  return makeFallback("rewrite_validation_failed");
}

// ── Run-level diagnostics aggregator (pipeline-facing) ──────────────────────

/**
 * Schema-version stamp for `log.whyItMatters` / `_meta.whyItMatters`.
 * Bumped when the counter shape grows or shrinks.
 */
export const WHY_IT_MATTERS_DIAGNOSTICS_SCHEMA_VERSION = "whyitmatters-v1";

/**
 * Empty run-level diagnostics shape — every key the aggregator may emit,
 * pre-initialized to zero/false.  Used as the base for full runs and as the
 * watermark short-circuit payload (with `watermarkShortCircuited: true`).
 */
export function emptyWhyItMattersRunDiagnostics() {
  return {
    schemaVersion: WHY_IT_MATTERS_DIAGNOSTICS_SCHEMA_VERSION,
    enabled: false,
    storiesAttempted: 0,
    pass: 0,
    rewriteOk: 0,
    fallback: 0,
    hardFail: 0,
    lowConfidence: 0,
    llmFailed: { write: 0, rewrite: 0 },
    latencyMs: { write: 0, rewrite: 0 },
    watermarkShortCircuited: false,
  };
}

/**
 * Fold per-story `resolveWhyItMatters` results into a single run-level
 * diagnostic object suitable for `log.whyItMatters` →
 * `_lastRunMeta.whyItMatters`.
 *
 * @param {Array<{trace?:object, diagnostics?:object}>} perStoryResults
 * @param {{ enabled?: boolean }} [extras]
 */
export function aggregateWhyItMattersDiagnostics(perStoryResults, extras = {}) {
  const agg = emptyWhyItMattersRunDiagnostics();
  if (typeof extras.enabled === "boolean") agg.enabled = extras.enabled;
  for (const r of perStoryResults ?? []) {
    if (!r || typeof r !== "object") continue;
    agg.storiesAttempted += 1;
    const d = r.diagnostics ?? {};
    const t = r.trace ?? {};
    if (d.fallbackUsed === true) {
      agg.fallback += 1;
    } else if (d.rewriteOk === true) {
      agg.rewriteOk += 1;
      agg.pass += 1;
    } else if (d.writerOk === true) {
      agg.pass += 1;
    }
    if (t.confidence === "low") agg.lowConfidence += 1;
    if (d.llmFailed?.write) agg.llmFailed.write += 1;
    if (d.llmFailed?.rewrite) agg.llmFailed.rewrite += 1;
    const lat = d.latencyMs ?? {};
    if (typeof lat.write === "number" && Number.isFinite(lat.write)) agg.latencyMs.write += lat.write;
    if (typeof lat.rewrite === "number" && Number.isFinite(lat.rewrite)) {
      agg.latencyMs.rewrite += lat.rewrite;
    }
  }
  return agg;
}
