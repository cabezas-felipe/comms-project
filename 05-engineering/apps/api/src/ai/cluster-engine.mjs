import { createHash } from "node:crypto";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { providerFor } from "./model-router.mjs";
import { withTimeout } from "./guardrails.mjs";
import { buildClusteringPrompt } from "./prompts.mjs";

export const CLUSTER_ENGINE_VERSION = "cluster-v1";

// ─── Zod schema for LLM clustering output ────────────────────────────────────
// Exported so the M8 cluster-smoke runner (and any future contract-shape
// checks) can validate against the same source of truth the real-provider
// parser already uses — no duplicated contract.

export const metaStoryOutputSchema = z.object({
  title: z.string().min(1),
  subtitle: z.string().min(1),
  source_item_ids: z.array(z.string().min(1)).min(1).max(5),
  summary: z.string().min(1),
  tags: z.object({
    topics: z.array(z.string()),
    keywords: z.array(z.string()),
    geographies: z.array(z.string()),
  }),
  // cluster-v4 (Q1 B1): grounded named entities the meta-story is about
  // (people, organizations, contests, places). OPTIONAL for backward
  // compatibility — fixtures and the mock/fallback paths that predate cluster-v4
  // omit it, and downstream relevance scoring falls back to `tags`. When present,
  // entities MUST be grounded in the referenced source evidence (no invention);
  // the prompt enforces this and grounding still gates the published claims.
  associated_entities: z.array(z.string()).optional(),
  factual_claims: z.array(z.string()).min(1),
  claim_evidence_map: z.record(z.string(), z.array(z.string())),
});

export const clusteringOutputSchema = z.object({
  meta_stories: z.array(metaStoryOutputSchema).max(5),
});

// ─── Stable ID generation ─────────────────────────────────────────────────────

/**
 * Derives a stable meta-story ID from evidence signature — NOT from title text.
 * Signature = sorted source_item_ids joined with first topic tag.
 * Stable: same articles + topic → same ID even when title wording changes.
 *
 * @param {{ source_item_ids: string[], tags?: { topics?: string[] } }} metaStory
 */
export function generateMetaStoryId(metaStory) {
  const sortedIds = [...(metaStory.source_item_ids ?? [])].sort().join(",");
  const topic = ((metaStory.tags?.topics ?? [])[0] ?? "").toLowerCase().trim();
  const signature = sortedIds + "::" + topic;
  return createHash("sha256").update(signature).digest("hex").slice(0, 16);
}

// ─── Mock clustering (deterministic, no AI call) ─────────────────────────────

function mockCluster(items, settings) {
  const byTopic = new Map();
  for (const item of items) {
    const topic = item.topic || "General";
    if (!byTopic.has(topic)) byTopic.set(topic, []);
    byTopic.get(topic).push(item);
  }

  const stories = [];
  for (const [topic, groupItems] of byTopic) {
    const sourceItems = groupItems.slice(0, 5);
    const title = `${topic} Developments`;
    const keywords = (settings.keywords ?? []).filter((k) =>
      sourceItems.some((i) =>
        (i.headline + " " + i.body.join(" ")).toLowerCase().includes(k.toLowerCase())
      )
    );
    const sourceItemIds = sourceItems.map((i) => i.sourceId);
    const factual_claims = sourceItems.map(
      (item) => `${item.outlet} reports: ${item.headline}`
    );
    const claim_evidence_map = Object.fromEntries(
      factual_claims.map((_, i) => [String(i), [sourceItems[i].sourceId]])
    );
    stories.push({
      title,
      subtitle: `Recent developments in ${topic.toLowerCase()}.`,
      source_item_ids: sourceItemIds,
      summary: `${title}. ${sourceItems.length} source${sourceItems.length === 1 ? "" : "s"} tracked.`,
      tags: {
        topics: [topic],
        keywords,
        geographies: [...new Set(sourceItems.flatMap((i) => i.geographies))],
      },
      factual_claims,
      claim_evidence_map,
    });
    if (stories.length >= 5) break;
  }

  return stories.map((ms) => ({ ...ms, meta_story_id: generateMetaStoryId(ms) }));
}

// ─── Real Anthropic clustering ────────────────────────────────────────────────

// ─── C2: clustering JSON resilience (safe-trim repair) ───────────────────────
//
// Empty repair diagnostics — the default state surfaced on `_meta` whenever no
// repair was needed (or the mock path ran).  Frozen so callers can't mutate the
// shared default; the pipeline reads a normalized copy via
// `readClusteringRepairDiagnostics`.
//
// Slice 3 (clustering structured-output hardening) extends the C2 shape with
// three additive, machine-parseable fields (all default null/false so existing
// consumers that read only `attempted`/`succeeded`/`failureReason` are
// unaffected):
//   - `rawFailureClass`    — classification of the INITIAL strict-parse failure
//                            (`json_parse_error` | `schema_validation_error` |
//                            `empty_response` | `parse_error`).  Previously the
//                            stage-1 error was swallowed; now it is observable
//                            even when the single repair pass later succeeds.
//   - `schemaErrorBucket`  — coarse, stable bucket for a schema-validation
//                            failure (see `classifySchemaIssues`); null unless
//                            the terminal/observed failure was schema-level.
//   - `coercion`           — structural normalization applied during the repair
//                            pass to make malformed-but-recoverable output
//                            valid within strict bounds (`array_wrap` | null).
//
// IMPORTANT — "raw failure observed" is NOT "terminal failure":
//   `rawFailureClass` and `schemaErrorBucket` describe what was wrong with the
//   model's RAW output.  On a RECOVERED run (`attempted=true, succeeded=true`)
//   they remain non-null to record what the repair pass fixed — yet stories
//   ARE published and this is NOT a clustering failure.  The single source of
//   truth for a TERMINAL failure is `succeeded=false` here (and, at the
//   pipeline level, a non-null `clusteringFailureReason` + `usedFallback
//   clustering=true`).  Downstream observability must never treat a non-null
//   `rawFailureClass`/`schemaErrorBucket` as a failure signal on its own.
export const EMPTY_CLUSTERING_REPAIR = Object.freeze({
  attempted: false,
  succeeded: false,
  failureReason: null,
  rawFailureClass: null,
  schemaErrorBucket: null,
  coercion: null,
});

// Stage-1 (strict) normalization: whitespace trim only.  Markdown-fence
// stripping is deliberately a REPAIR transformation (C2 §2), not part of the
// strict path — so a fenced/wrapped response flows through the single repair
// attempt and is surfaced via `clusteringRepairAttempted`, while clean raw JSON
// parses with no repair.
function normalizeNormalPath(raw) {
  return String(raw ?? "").trim();
}

// Map a validated clustering envelope to meta-stories with stable IDs.
function mapValidatedStories(result) {
  return result.meta_stories.map((ms) => ({
    ...ms,
    meta_story_id: generateMetaStoryId(ms),
  }));
}

// Stage 1 (strict): parse + schema-validate a candidate string into
// meta-stories with NO structural coercion.  Throws on either a JSON syntax
// error or a schema mismatch.  The strict envelope is an object with a
// `meta_stories` array — a bare top-level array is rejected here and only
// recovered (observably) on the repair path via `validateRepairedText`.
function validateClusteringText(text) {
  const parsed = JSON.parse(text);
  const result = clusteringOutputSchema.parse(parsed);
  return mapValidatedStories(result);
}

// Stage 2 (repair): parse + ONE structural coercion within strict bounds, then
// schema-validate.  The only coercion is wrapping a bare top-level array of
// meta-stories into the `{ meta_stories: [...] }` envelope — a common model
// malformation.  This is NOT content rewriting: every element still must pass
// the full `metaStoryOutputSchema`, and the max-5 cap still applies, so no
// fabricated or relaxed stories can slip through.  Returns the mapped stories
// plus the `coercion` tag applied (`array_wrap` | null).  Throws on syntax or
// schema failure exactly like the strict path.
function validateRepairedText(text) {
  const parsed = JSON.parse(text);
  let candidate = parsed;
  let coercion = null;
  if (Array.isArray(parsed)) {
    candidate = { meta_stories: parsed };
    coercion = "array_wrap";
  }
  const result = clusteringOutputSchema.parse(candidate);
  return { stories: mapValidatedStories(result), coercion };
}

// Concise classification of a failed parse for `rawFailureClass` /
// `failureReason`.  An empty/whitespace-only payload is its own class so an
// operator can distinguish "model returned nothing usable" from "model
// returned malformed JSON".
function classifyParseFailure(err) {
  if (err instanceof SyntaxError) return "json_parse_error";
  // Zod validation errors expose an `issues` array.
  if (err && Array.isArray(err.issues)) return "schema_validation_error";
  return "parse_error";
}

// Slice 3: derive a coarse, STABLE bucket from a zod validation error so schema
// failures are observable by class rather than collapsing into one opaque
// `schema_validation_error` reason.  Deterministic: zod emits `issues` in a
// stable encounter order, and we key off the first issue's path + code.  The
// buckets are intentionally coarse (operator-actionable groupings, not a 1:1
// mirror of every zod code) and fall back to `schema_other` for anything
// unmapped so the function never throws on an unexpected shape.
//
// Buckets:
//   missing_meta_stories     — top-level `meta_stories` absent / not an array
//   too_many_meta_stories    — more than 5 meta-stories (max cap exceeded)
//   empty_source_item_ids    — a story referenced zero sourceIds (min 1)
//   too_many_source_item_ids — a story referenced more than 5 sourceIds (max)
//   missing_required_field   — a required field was undefined
//   empty_string_field       — a required string was empty (min 1)
//   invalid_type             — a field had the wrong JSON type
//   schema_other             — any other / unmapped validation issue
function classifySchemaIssues(err) {
  const issues = err && Array.isArray(err.issues) ? err.issues : [];
  if (issues.length === 0) return "schema_other";
  const issue = issues[0];
  const path = Array.isArray(issue.path) ? issue.path : [];
  const code = issue.code ?? "";

  // Top-level container problems (path is exactly ["meta_stories"]).
  if (path.length === 1 && path[0] === "meta_stories") {
    if (code === "too_big") return "too_many_meta_stories";
    if (code === "invalid_type") return "missing_meta_stories";
  }
  // `source_item_ids` array-bound violations anywhere in the tree.
  if (path.includes("source_item_ids")) {
    if (code === "too_small") return "empty_source_item_ids";
    if (code === "too_big") return "too_many_source_item_ids";
  }
  // Generic codes (leaf-level).
  if (code === "invalid_type") {
    return issue.received === "undefined" ? "missing_required_field" : "invalid_type";
  }
  if (code === "too_small") return "empty_string_field";
  return "schema_other";
}

/**
 * C2 safe-trim repair — STRUCTURAL TRIMMING ONLY, never content rewriting.
 *
 * Allowed transformations:
 *   - strip markdown code-fence wrappers (``` / ```json) wherever they bracket
 *     the payload
 *   - trim surrounding whitespace
 *   - isolate the outermost bounded JSON region: from the first `{`/`[` to the
 *     matching last `}`/`]` (whichever bracket opens first wins)
 *
 * Explicitly NOT done: trailing-comma rewrites, quote insertion, key/value
 * rewrites, or any heuristic text surgery inside the region.  Returns the
 * trimmed candidate string, or `null` when no plausible JSON region exists.
 * Exported for unit testing of the trim contract.
 */
export function safeTrimRepair(raw) {
  // Strip every code-fence marker, then trim. Fences are wrappers, not content.
  const text = String(raw ?? "")
    .replace(/```(?:json)?/gi, "")
    .trim();
  if (!text) return null;

  // Isolate the outermost bounded region. Pick the bracket type that opens
  // first so a top-level object or array is handled symmetrically; slice from
  // that opener to the last matching closer. This is a substring isolation —
  // no characters inside the region are inserted or rewritten.
  const firstObj = text.indexOf("{");
  const firstArr = text.indexOf("[");
  if (firstObj === -1 && firstArr === -1) return null;
  let closer, start;
  if (firstArr === -1 || (firstObj !== -1 && firstObj < firstArr)) {
    closer = "}";
    start = firstObj;
  } else {
    closer = "]";
    start = firstArr;
  }
  const end = text.lastIndexOf(closer);
  if (end <= start) return null;
  const region = text.slice(start, end + 1).trim();
  return region.length > 0 ? region : null;
}

/**
 * Parse a raw clustering response into validated meta-stories.
 *
 * C2 (clustering JSON resilience) + Slice 3 (structured-output hardening):
 * two-stage parse, single repair attempt, with explicit failure classification
 * at every stage.
 *   1. Normal parse — the strict current path (`normalizeNormalPath` + parse).
 *      On failure the error class is recorded as `rawFailureClass` (and, when
 *      schema-level, bucketed into `schemaErrorBucket`) instead of being
 *      swallowed.
 *   2. On ANY stage-1 failure, ONE safe-trim repair attempt (`safeTrimRepair`)
 *      followed by ONE structural coercion within strict bounds (bare array →
 *      `{ meta_stories }`, tagged on `repair.coercion`), then validate once
 *      more.  No second repair, no content rewriting.
 * If the repaired text still fails we throw (the message never matches the
 * pipeline's timeout regex, so the refresh pipeline classifies it as a
 * clustering `error` and fails closed — Slice 1 continuity contract).  The
 * thrown error carries `_clusteringRepair` so the pipeline can surface the
 * full diagnostics on `_meta`.
 *
 * Returns `{ stories, repair }`; `repair` is the extended shape documented on
 * `EMPTY_CLUSTERING_REPAIR`.  Exported for unit testing.
 */
export function parseClusteringResponse(raw) {
  const repair = {
    attempted: false,
    succeeded: false,
    failureReason: null,
    rawFailureClass: null,
    schemaErrorBucket: null,
    coercion: null,
  };

  const normalized = normalizeNormalPath(raw);
  // An empty/whitespace-only payload is a distinct, observable class — the
  // strict parse below would throw a generic SyntaxError otherwise.
  if (!normalized) {
    repair.attempted = true;
    repair.rawFailureClass = "empty_response";
    repair.failureReason = "no_json_region";
    console.warn("[cluster-engine] clustering response empty (reason=empty_response)");
    const err = new Error("Clustering response parse failed: empty response");
    err._clusteringRepair = repair;
    throw err;
  }

  // Stage 1: strict normal parse — unchanged happy path.
  try {
    return { stories: validateClusteringText(normalized), repair };
  } catch (firstErr) {
    repair.attempted = true;
    repair.rawFailureClass = classifyParseFailure(firstErr);
    if (repair.rawFailureClass === "schema_validation_error") {
      repair.schemaErrorBucket = classifySchemaIssues(firstErr);
    }
  }

  // Stage 2: exactly one safe-trim repair attempt (+ one structural coercion).
  console.warn(
    `[cluster-engine] initial clustering parse failed (rawClass=${repair.rawFailureClass}` +
      `${repair.schemaErrorBucket ? ` bucket=${repair.schemaErrorBucket}` : ""}) — attempting safe-trim repair`
  );
  const repaired = safeTrimRepair(raw);
  if (repaired === null) {
    repair.failureReason = "no_json_region";
    console.warn("[cluster-engine] safe-trim repair failed (reason=no_json_region)");
    const err = new Error("Clustering response parse failed: no JSON region after safe-trim repair");
    err._clusteringRepair = repair;
    throw err;
  }
  try {
    const { stories, coercion } = validateRepairedText(repaired);
    // RECOVERED run: the repair pass parsed cleanly, so stories are returned
    // and published.  `repair.rawFailureClass` (and `schemaErrorBucket`, when
    // the raw failure was schema-level) stay populated from stage 1 on purpose
    // — they record what was wrong with the RAW output, not a terminal failure.
    // `succeeded=true` is the unambiguous "recovered, not failed" marker.
    repair.succeeded = true;
    repair.coercion = coercion;
    console.log(
      `[cluster-engine] safe-trim repair succeeded — clustering response parsed after repair` +
        `${coercion ? ` (coercion=${coercion})` : ""}`
    );
    return { stories, repair };
  } catch (secondErr) {
    repair.failureReason = classifyParseFailure(secondErr);
    if (repair.failureReason === "schema_validation_error") {
      repair.schemaErrorBucket = classifySchemaIssues(secondErr);
    }
    console.warn(
      `[cluster-engine] safe-trim repair failed (reason=${repair.failureReason}` +
        `${repair.schemaErrorBucket ? ` bucket=${repair.schemaErrorBucket}` : ""})`
    );
    const msg = secondErr instanceof Error ? secondErr.message : String(secondErr);
    const err = new Error(`Clustering response parse failed after safe-trim repair: ${msg}`);
    err._clusteringRepair = repair;
    throw err;
  }
}

// Attach C2 repair diagnostics to the returned meta-story array as a
// non-enumerable property so the pipeline can read them without polluting
// iteration/serialization of the stories.
function attachRepairDiagnostics(stories, repair) {
  try {
    Object.defineProperty(stories, "_clusteringRepair", {
      value: { ...repair },
      enumerable: false,
      configurable: true,
      writable: true,
    });
  } catch {
    // Non-fatal: diagnostics are best-effort; never block clustering on them.
  }
  return stories;
}

/**
 * Read C2 repair diagnostics off a clustering result (the returned array) or a
 * thrown clustering error.  Always returns a normalized
 * `{ attempted, succeeded, failureReason }` shape, defaulting to "no repair"
 * when the source carries none (mock path, empty input, etc.).
 */
export function readClusteringRepairDiagnostics(source) {
  const r = source && source._clusteringRepair;
  if (r && typeof r === "object") {
    return {
      attempted: !!r.attempted,
      succeeded: !!r.succeeded,
      failureReason: r.failureReason ?? null,
      // Slice 3 additive fields — normalized to null when absent so older
      // producers (or hand-built diagnostics) read as "not classified".
      rawFailureClass: r.rawFailureClass ?? null,
      schemaErrorBucket: r.schemaErrorBucket ?? null,
      coercion: r.coercion ?? null,
    };
  }
  return { ...EMPTY_CLUSTERING_REPAIR };
}

// ─── Prompt 1: clustering failure subtype taxonomy ───────────────────────────
//
// The pipeline's terminal `clusteringFailureReason` is intentionally coarse —
// `'timeout' | 'error' | null` — and the catch-all `error` bucket hides several
// distinct, separately-actionable failure modes (a malformed model payload, a
// provider/transport fault, an unattributable error).  Prompt 1 adds a STABLE,
// additive sub-classification so an operator can split `error` WITHOUT changing
// any gate threshold or the existing reason contract.  The mapping:
//
//   timeout_budget   — the clustering wall-clock budget was exhausted (the call
//                      timed out / was aborted).  This is the SAME signal that
//                      drives `clusteringFailureReason === "timeout"`; the
//                      pipeline derives the legacy reason from the subtype so the
//                      two never drift.
//   parse            — the model returned a response we could not parse/validate
//                      into the clustering contract (carries the C2/Slice-3
//                      `_clusteringRepair` diagnostics — JSON syntax, schema, or
//                      empty/again-empty payload from `parseClusteringResponse`).
//   provider_request — the provider call itself failed or returned an unusable
//                      envelope: missing API key, auth/permission, rate-limit,
//                      overload, connection/transport fault, or an empty provider
//                      response (the engine's own `clusterWithAnthropic` /
//                      `clusterItems` throw sites, plus Anthropic SDK errors).
//   unknown          — a non-timeout failure we could not attribute to a class
//                      above.  A non-empty `unknown` rate is itself a signal that
//                      the taxonomy needs another bucket — never a silent drop.
//
// Pure and deterministic (regex + own-property checks only) so the mapping is
// unit-lockable without a real provider.  Subtype names are snake_case and
// frozen — downstream dashboards/logs key off them.
export const CLUSTERING_FAILURE_SUBTYPE = Object.freeze({
  TIMEOUT_BUDGET: "timeout_budget",
  PARSE: "parse",
  PROVIDER_REQUEST: "provider_request",
  UNKNOWN: "unknown",
});

// Same regex the pipeline used to split timeout from error — kept here so the
// subtype and the legacy `clusteringFailureReason` derive from ONE source and
// the timeout→reason mapping stays byte-identical to the pre-Prompt-1 behavior.
const CLUSTER_TIMEOUT_MESSAGE_RE = /timed out|timeout|abort/i;

// Concrete provider/transport failure signals.  Covers the engine's own throw
// sites (missing API key, "returned empty clustering response") plus common
// Anthropic SDK / Node transport error language.  Deliberately conservative:
// anything not matched here (and not a parse failure or timeout) stays `unknown`
// rather than being force-fit into `provider_request`.
const CLUSTER_PROVIDER_MESSAGE_RE =
  /api[_ ]?key|anthropic_api_key|rate[ _-]?limit|overloaded|temporarily unavailable|service unavailable|\bunavailable\b|authentication|unauthorized|forbidden|permission|connection error|econnreset|enotfound|etimedout|fetch failed|socket hang up|returned empty|empty[^]*?response|status code|\b(?:429|5\d{2})\b/i;

// True when a thrown error looks like a provider/transport fault: an Anthropic
// SDK `APIError` (numeric `status`) / connection error (by name), or a concrete
// provider message.  Kept narrow so generic messages fall through to `unknown`.
function isProviderRequestError(err, msg) {
  if (err && typeof err === "object") {
    if (typeof err.status === "number") return true;
    const name = typeof err.name === "string" ? err.name : "";
    const ctor =
      err.constructor && typeof err.constructor.name === "string"
        ? err.constructor.name
        : "";
    if (/APIError|APIConnection|Anthropic/i.test(`${name} ${ctor}`)) return true;
  }
  return CLUSTER_PROVIDER_MESSAGE_RE.test(msg);
}

/**
 * Classify a thrown clustering failure into a stable subtype (see
 * `CLUSTERING_FAILURE_SUBTYPE`).  Deterministic priority:
 *   1. timeout_budget   — message matches the timeout/abort regex
 *   2. parse            — error carries `_clusteringRepair` diagnostics
 *   3. provider_request — SDK API error (numeric `status` / APIError-ish name)
 *                         or a concrete provider/transport message
 *   4. unknown          — none of the above
 *
 * Additive + fail-closed-preserving: this NEVER changes whether clustering
 * failed, only how the (already terminal) failure is labeled.  Pure; exported
 * for unit testing of the mapping contract.
 */
export function classifyClusteringFailureSubtype(err) {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  if (CLUSTER_TIMEOUT_MESSAGE_RE.test(msg)) {
    return CLUSTERING_FAILURE_SUBTYPE.TIMEOUT_BUDGET;
  }
  if (err && typeof err === "object" && err._clusteringRepair) {
    return CLUSTERING_FAILURE_SUBTYPE.PARSE;
  }
  if (isProviderRequestError(err, msg)) {
    return CLUSTERING_FAILURE_SUBTYPE.PROVIDER_REQUEST;
  }
  return CLUSTERING_FAILURE_SUBTYPE.UNKNOWN;
}

/**
 * Derive the coarse legacy `clusteringFailureReason` (`"timeout" | "error"`)
 * from a clustering failure subtype.  Single source of truth for the
 * subtype→reason mapping so the two never drift: `timeout_budget` maps to
 * "timeout" (byte-identical to the pre-Prompt-1 regex split); every other
 * subtype maps to "error".  Pure; exported for unit testing of the contract.
 */
export function clusteringReasonFromSubtype(subtype) {
  return subtype === CLUSTERING_FAILURE_SUBTYPE.TIMEOUT_BUDGET ? "timeout" : "error";
}

// Clustering completion token budget.  Named (not a new tuning knob — same
// value that was inline) so the observability line can report it verbatim.
export const CLUSTER_MAX_TOKENS = 2048;

// ─── Step 2: structured-path observability ───────────────────────────────────
//
// One stable, greppable line per clustering attempt/outcome, prefix
// `[cluster-engine.obs]`, so an operator can see which execution path each
// refresh took WITHOUT decoding the C2/Slice-3 repair diagnostics.  The three
// outcomes map onto the existing parse paths (no behavior change):
//   - structured success            → mode=structured result=ok
//   - structured failed → recovered → mode=legacy     result=fallback fallbackTo=legacy
//   - both paths failed (terminal)  → mode=legacy     result=fail
// "legacy" is the safe-trim repair path (the looser, pre-structured handling
// the strict parse falls back to).  This is diagnostics-only — it never alters
// the returned stories or the thrown error.

/**
 * Map a normalized clustering repair-diagnostics object to the observability
 * outcome fields.  Pure; exported for unit testing.  `fallbackTo` is present
 * ONLY on the recovered (fallback) outcome, per the field contract.
 *
 * @param {{ attempted:boolean, succeeded:boolean, failureReason?:string|null, rawFailureClass?:string|null }} repair
 * @returns {{ mode:string, result:string, errorClass:string|null, fallbackTo?:string }}
 */
export function deriveClusterObs(repair) {
  if (!repair || !repair.attempted) {
    // Strict structured parse succeeded with no repair pass.
    return { mode: "structured", result: "ok", errorClass: null };
  }
  if (repair.succeeded) {
    // Strict parse failed; the safe-trim (legacy) repair pass recovered.
    return {
      mode: "legacy",
      result: "fallback",
      errorClass: repair.rawFailureClass ?? null,
      fallbackTo: "legacy",
    };
  }
  // Both the strict and the repair path failed — terminal clustering failure.
  return {
    mode: "legacy",
    result: "fail",
    errorClass: repair.failureReason ?? repair.rawFailureClass ?? "parse_error",
  };
}

/**
 * Format the observability line with a stable key order.  `errorClass` and
 * `stopReason` always render (as `null` when absent) so the field set per line
 * is predictable; `fallbackTo` is omitted unless set.  Pure; exported for tests.
 */
export function formatClusterObsLine(fields) {
  const order = ["mode", "result", "model", "maxTokens", "stopReason", "errorClass", "fallbackTo"];
  const parts = [];
  for (const key of order) {
    const value = fields[key];
    if (value === undefined) continue; // omit absent optional fields (fallbackTo)
    parts.push(`${key}=${value === null ? "null" : value}`);
  }
  return `[cluster-engine.obs] ${parts.join(" ")}`;
}

// Emit one observability line. Failures go to stderr (console.error), successes
// and recoveries to stdout. Returns the line for test assertions.
function emitClusterObs(outcome, ctx) {
  const fields = {
    mode: outcome.mode,
    result: outcome.result,
    model: ctx.model,
    maxTokens: ctx.maxTokens,
    stopReason: ctx.stopReason ?? null,
    errorClass: outcome.errorClass ?? null,
  };
  if (outcome.fallbackTo) fields.fallbackTo = outcome.fallbackTo;
  const line = formatClusterObsLine(fields);
  if (outcome.result === "fail") console.error(line);
  else console.log(line);
  return line;
}

/**
 * Run one real-provider clustering round-trip and parse it, emitting exactly one
 * `[cluster-engine.obs]` line for the outcome.  Exported so tests can inject a
 * fake `client` (any object with `messages.create`) and drive the three paths
 * deterministically with no network.  Production callers omit `client` and a
 * real Anthropic client is constructed.
 */
export async function clusterWithAnthropic({ apiKey, model, items, settings, timeoutMs, client }) {
  const anthropic = client ?? new Anthropic({ apiKey, timeout: timeoutMs });
  const prompt = buildClusteringPrompt(items, settings);
  const message = await anthropic.messages.create({
    model,
    max_tokens: CLUSTER_MAX_TOKENS,
    messages: [{ role: "user", content: prompt }],
  });
  const obsCtx = {
    model,
    maxTokens: CLUSTER_MAX_TOKENS,
    stopReason: message?.stop_reason ?? null,
  };
  const block = message?.content?.[0];
  if (!block || block.type !== "text" || !block.text.trim()) {
    emitClusterObs({ mode: "structured", result: "fail", errorClass: "empty_response" }, obsCtx);
    throw new Error("Anthropic returned empty clustering response");
  }
  let parsed;
  try {
    parsed = parseClusteringResponse(block.text);
  } catch (err) {
    emitClusterObs(deriveClusterObs(readClusteringRepairDiagnostics(err)), obsCtx);
    throw err;
  }
  emitClusterObs(deriveClusterObs(parsed.repair), obsCtx);
  return attachRepairDiagnostics(parsed.stories, parsed.repair);
}

// ─── Fallback: graceful grouping without LLM ─────────────────────────────────

export function gracefulFallbackClustering(items, settings) {
  const byTopic = new Map();
  for (const item of items) {
    const topic = item.topic || "General";
    if (!byTopic.has(topic)) byTopic.set(topic, []);
    byTopic.get(topic).push(item);
  }

  const stories = [];
  for (const [topic, groupItems] of byTopic) {
    const sourceItems = groupItems.slice(0, 5);
    const title = `${topic} Updates`;
    const sourceItemIds = sourceItems.map((i) => i.sourceId);
    const factual_claims = sourceItems.map(
      (item) => `${item.outlet} reports: ${item.headline}`
    );
    const claim_evidence_map = Object.fromEntries(
      factual_claims.map((_, i) => [String(i), [sourceItems[i].sourceId]])
    );
    const story = {
      title,
      subtitle: `Recent ${topic.toLowerCase()} updates.`,
      source_item_ids: sourceItemIds,
      summary: extractiveSummary(title, sourceItems),
      tags: {
        topics: [topic],
        keywords: [],
        geographies: [...new Set(sourceItems.flatMap((i) => i.geographies))],
      },
      factual_claims,
      claim_evidence_map,
    };
    stories.push({ meta_story_id: generateMetaStoryId(story), ...story });
    if (stories.length >= 5) break;
  }

  return stories;
}

// ─── Extractive summary fallback ──────────────────────────────────────────────

export function extractiveSummary(title, sourceItems) {
  const headlines = sourceItems
    .slice(0, 3)
    .map((i) => i.headline)
    .join("; ");
  return `${title}. ${headlines}.`;
}

// ─── Grounding verifier ───────────────────────────────────────────────────────

// C0 summary cap — meta-story summary is a deterministic join of grounded
// claims, soft-capped at SUMMARY_MAX_CHARS.  Truncation appends an ellipsis
// at the nearest sentence boundary so we never ship a half-word.  The number
// is a product call (~400–500 chars keeps the card readable).  See Prompt 1.
const SUMMARY_MAX_CHARS = 500;

function normalizeWhitespace(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

function capSummary(text, maxChars = SUMMARY_MAX_CHARS) {
  if (text.length <= maxChars) return text;
  const head = text.slice(0, maxChars).trimEnd();
  // Try to clip at the last sentence boundary so we never end mid-word.
  const lastSentence = head.lastIndexOf(". ");
  if (lastSentence >= Math.floor(maxChars * 0.6)) {
    return head.slice(0, lastSentence + 1);
  }
  // Otherwise clip at last space and add ellipsis.
  const lastSpace = head.lastIndexOf(" ");
  if (lastSpace > 0) return head.slice(0, lastSpace) + "…";
  return head + "…";
}

/**
 * Joins grounded factual claims into a single summary string, separated by
 * a space; normalizes whitespace and caps length per C0 policy.  Each input
 * claim is expected to be a verified sentence — callers should pass only
 * claims that have already passed the evidence-map gate.
 *
 * @param {object} metaStory — meta-story carrying `factual_claims`
 * @returns {string} summary text (already capped)
 */
export function synthesizeSummary(metaStory) {
  const claims = Array.isArray(metaStory?.factual_claims)
    ? metaStory.factual_claims
        .map((c) => normalizeWhitespace(c))
        .filter((c) => c.length > 0)
    : [];
  if (claims.length === 0) return normalizeWhitespace(metaStory?.summary ?? "");
  // Ensure each claim ends with terminal punctuation so the join reads as
  // a sequence of sentences rather than run-on prose.
  const normalized = claims.map((c) => (/[.!?]$/.test(c) ? c : `${c}.`));
  return capSummary(normalizeWhitespace(normalized.join(" ")));
}

/**
 * Verifies grounding in two gates:
 *
 * Gate 1 (source-level): source_item_ids must reference real pool items.
 *   - All hallucinated → invalid "no_valid_source_ids" (discard)
 *   - Partial hallucinated → invalid "partial_source_ids" (trimmed ids on
 *     the returned object; pipeline **drops** these under **J1a** — no salvage)
 *
 * Gate 2 (claim-level): each factual_claims[i] must have ≥1 valid source in
 *   claim_evidence_map["i"]. A single claim with no valid backing rejects the
 *   entire story ("ungrounded_claims").  Stories with empty factual_claims pass.
 *
 * Gate 3 (valid path — C0 grounding policy for the meta-story fields PR):
 *   when `factual_claims.length > 0`:
 *     - `subtitle` is set to the **first** verified claim (clustering semantics
 *       — one sentence placing the story in context).
 *     - `summary` is a deterministic join of **all** verified claims (narrative
 *       across sources), whitespace-normalized and capped (~500 chars).  This
 *       guarantees `subtitle !== summary` whenever ≥2 claims are present.
 *   When `factual_claims.length === 0`, the model's `summary` / `subtitle`
 *   pass through unchanged.
 * @param {Array} metaStories
 * @param {Map<string, object>} sourceItemsById — keyed by sourceId
 * @returns {{ valid: Array, invalid: Array }}
 */
export function verifyGrounding(metaStories, sourceItemsById) {
  const valid = [];
  const invalid = [];

  for (const ms of metaStories) {
    // Gate 1: at least one source_item_id must be real
    const existingIds = ms.source_item_ids.filter((id) => sourceItemsById.has(id));

    if (existingIds.length === 0) {
      console.warn(
        `[grounding] meta_story="${ms.meta_story_id}" rejected: no valid source_item_ids (all hallucinated)`
      );
      invalid.push({ ...ms, groundingFailure: "no_valid_source_ids" });
      continue;
    }

    // Gate 2: every factual_claim[i] must have ≥1 valid evidence ID
    const claims = Array.isArray(ms.factual_claims) ? ms.factual_claims : [];
    const evidenceMap =
      ms.claim_evidence_map && typeof ms.claim_evidence_map === "object"
        ? ms.claim_evidence_map
        : {};
    const badClaimIndices = claims.reduce((acc, _, i) => {
      const evidence = evidenceMap[String(i)] ?? [];
      if (!evidence.some((id) => sourceItemsById.has(id))) acc.push(i);
      return acc;
    }, []);

    if (badClaimIndices.length > 0) {
      console.warn(
        `[grounding] meta_story="${ms.meta_story_id}" rejected: claims [${badClaimIndices.join(",")}] lack valid evidence`
      );
      invalid.push({ ...ms, groundingFailure: "ungrounded_claims" });
      continue;
    }

    // Gate 1 (partial): hallucinated ids trimmed; story is invalid — pipeline drops (J1a)
    if (existingIds.length < ms.source_item_ids.length) {
      const hallucinated = ms.source_item_ids.filter((id) => !sourceItemsById.has(id));
      console.warn(
        `[grounding] meta_story="${ms.meta_story_id}" partial: hallucinated ids=[${hallucinated.join(",")}] — invalid (strict drop)`
      );
      invalid.push({
        ...ms,
        source_item_ids: existingIds,
        groundingFailure: "partial_source_ids",
      });
      continue;
    }

    // Gate 3 (summary/subtitle — C0 policy): replace model-prose with verified-
    // claim text so ungrounded sentences cannot reach the publish path.  The
    // subtitle takes the first claim (one-sentence contextual placement);
    // the summary is the deterministic join of all claims (narrative across
    // sources) via `synthesizeSummary`.
    const groundedSubtitle =
      claims.length > 0 ? normalizeWhitespace(claims[0]) : ms.subtitle;
    const groundedSummary =
      claims.length > 0 ? synthesizeSummary(ms) : ms.summary;

    valid.push({ ...ms, summary: groundedSummary, subtitle: groundedSubtitle });
  }

  return { valid, invalid };
}

// ─── Main entry point ─────────────────────────────────────────────────────────

// Default clustering wall-clock budget (ms).  Larger than the global
// TEMPO_AI_TIMEOUT_MS because the cluster prompt is the single largest AI
// round-trip; the candidate set is C1-capped so the round-trip is bounded.
export const CLUSTER_TIMEOUT_MS_DEFAULT = 60000;

/**
 * Resolve the clustering wall-clock budget (ms).  An explicit `override`
 * (finite, > 0) wins — Slice 4's interactive fast-path passes a tighter budget
 * here to bound onboarding latency.  Otherwise read `TEMPO_AI_CLUSTER_TIMEOUT_MS`,
 * falling back to `CLUSTER_TIMEOUT_MS_DEFAULT`.  Exported so the pipeline/tests
 * can assert the precedence without driving a real provider call.
 */
export function resolveClusterTimeoutMs(override) {
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }
  const env = Number(process.env.TEMPO_AI_CLUSTER_TIMEOUT_MS);
  return Number.isFinite(env) && env > 0 ? Math.floor(env) : CLUSTER_TIMEOUT_MS_DEFAULT;
}

/**
 * Cluster source items into meta-stories using the specified model.
 * Uses mock clustering when model is a mock provider.
 * Throws on provider error, API key missing, timeout, or schema validation failure.
 * Callers are responsible for fallback logic (gracefulFallbackClustering).
 *
 * @param {Array} items — normalized source items (filtered pool)
 * @param {object} settings — user settings (for keyword/tag extraction in mock)
 * @param {string} model — capability model string (e.g. "anthropic:claude-haiku-4-5-20251001")
 * @param {{ timeoutMs?: number }} [opts] — Slice 4: optional per-call clustering
 *   timeout override (ms).  The interactive fast-path passes a tighter budget to
 *   cap onboarding latency; omitted/invalid → `TEMPO_AI_CLUSTER_TIMEOUT_MS` /
 *   `CLUSTER_TIMEOUT_MS_DEFAULT`.  Additive and backward-compatible: existing
 *   3-arg callers and test `clusterFn` stubs are unaffected.
 * @returns {Promise<Array>} — array of meta-story objects with meta_story_id
 */
export async function clusterItems(items, settings, model, opts = {}) {
  if (!items.length) return [];

  const provider = providerFor(model);
  const modelName = model.includes(":") ? model.slice(model.indexOf(":") + 1) : model;
  // Clustering gets its own timeout budget (default 60s) — larger than the
  // global TEMPO_AI_TIMEOUT_MS because the cluster prompt is the single
  // largest AI round-trip (whole candidate pool) and the publish path retries
  // it once before failing closed (see refresh-pipeline.mjs). The candidate set
  // is capped (C1) so the round-trip is bounded.  An explicit `opts.timeoutMs`
  // (Slice 4 interactive fast-path) overrides the env/default budget.
  const timeoutMs = resolveClusterTimeoutMs(opts?.timeoutMs);

  if (provider === "mock-anthropic" || provider === "mock-openai") {
    return mockCluster(items, settings);
  }

  if (provider === "anthropic") {
    const apiKey = process.env.TEMPO_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        "TEMPO_ANTHROPIC_API_KEY (or ANTHROPIC_API_KEY) is required for anthropic: clustering models"
      );
    }
    return withTimeout(
      () => clusterWithAnthropic({ apiKey, model: modelName, items, settings, timeoutMs }),
      timeoutMs,
      `Anthropic clustering timed out (${modelName})`
    );
  }

  // Default: mock fallback for unknown providers
  return mockCluster(items, settings);
}
