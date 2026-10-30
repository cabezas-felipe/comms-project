// Runtime-local mirror of `@tempo/contracts/src/schemas.ts`.
//
// Why this exists: the API runs on Vercel as a single function bundle.  When
// runtime code imports `@tempo/contracts`, Node resolves it through the
// package's `exports` map to `dist/index.js`, which only exists after a build
// step.  In some Vercel build paths that artifact is missing at function cold
// start, producing `ERR_MODULE_NOT_FOUND`.  Mirroring the shapes here keeps the
// API runtime depending only on source files committed alongside it.
//
// A parity test (`contracts-runtime.parity.test.mjs`) imports both modules
// side-by-side and asserts behavioral equivalence so this copy cannot silently
// drift.

import { z } from "zod";

export const CONTRACT_VERSION = "2026-05-19-meta-story-fields";

export const geographySchema = z.enum(["US", "Colombia"]);
export const topicSchema = z.enum([
  "Diplomatic relations",
  "Migration policy",
  "Security cooperation",
]);
export const sourceKindSchema = z.enum(["traditional", "social"]);
export const storyPrioritySchema = z.enum(["top", "standard"]);

export const sourceSchema = z.object({
  id: z.string().min(1),
  outlet: z.string().min(1),
  byline: z.string().optional(),
  kind: sourceKindSchema,
  weight: z.number().min(0).max(100),
  url: z.string().min(1),
  minutesAgo: z.number().nonnegative(),
  headline: z.string().min(1),
  body: z.array(z.string()).min(1),
});

export const storyTagsSchema = z.object({
  topics: z.array(z.string()),
  keywords: z.array(z.string()),
  geographies: z.array(z.string()),
});

export const storySchema = z.object({
  id: z.string().min(1),
  metaStoryId: z.string().optional(),
  title: z.string().min(1),
  // Meta-story fields PR (Prompt 1): subtitle required, takeaway removed.
  // See packages/contracts/src/schemas.ts for full rationale.
  subtitle: z.string().min(1),
  geographies: z.array(geographySchema),
  topic: topicSchema.optional(),
  summary: z.string().min(1),
  whyItMatters: z.string().min(1),
  whatChanged: z.string().min(1),
  priority: storyPrioritySchema,
  outletCount: z.number().int().nonnegative(),
  tags: storyTagsSchema,
  sources: z.array(sourceSchema).min(1),
});

export const dashboardPayloadSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  stories: z.array(storySchema),
});

export const settingsPayloadSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  topics: z.array(z.string().min(1)),
  keywords: z.array(z.string().min(1)),
  geographies: z.array(z.string().min(1)),
  traditionalSources: z.array(z.string().min(1)),
  socialSources: z.array(z.string().min(1)),
});

// ─── Refresh fail-safe contract (mirror of @tempo/contracts) ──────────────────
// Surfaced on `_meta` so a client can tell a TRUE quiet/empty success apart from
// a refresh FAILURE (or B3 DEGRADED deterministic rescue) that also returns
// `stories: []` / bounded stories. Kept in lockstep with the TS package by the
// parity test. See packages/contracts/src/schemas.ts for full rationale.
export const refreshFailureSubtypeSchema = z.enum([
  "parse",
  "timeout",
  "provider_request",
  "unknown",
]);

export const refreshFailureSchema = z.object({
  reason: z.string().min(1),
  subtype: refreshFailureSubtypeSchema,
  attempts: z.number().int().positive(),
  retryable: z.boolean(),
  retryAfterMs: z.number().int().nonnegative().optional(),
  nextRetryAt: z.string().min(1).optional(),
});

// B3 — deterministic relevance-gated fallback (B2) diagnostics (counts only).
export const deterministicClusteringDiagnosticsSchema = z
  .object({
    inputCount: z.number().int().nonnegative(),
    eligibleCount: z.number().int().nonnegative(),
    outputCount: z.number().int().nonnegative(),
    excludedReasons: z.record(z.string(), z.number().int().nonnegative()),
  })
  .passthrough();

export const dashboardRefreshFailsafeMetaSchema = z
  .object({
    // B3: `degraded` = LLM clustering failed but the deterministic fallback
    // published bounded stories (a real publish, not a failure).
    refreshStatus: z.enum(["ok", "degraded", "failed"]),
    refreshFailure: refreshFailureSchema.nullable(),
    usedPriorSnapshot: z.boolean(),
    // B3 — additive deterministic-fallback signals; OPTIONAL for back-compat.
    usedDeterministicClustering: z.boolean().optional(),
    clusteringLlmFailed: z.boolean().optional(),
    deterministicClusteringDiagnostics: deterministicClusteringDiagnosticsSchema.optional(),
  })
  .passthrough()
  .superRefine((val, ctx) => {
    if (val.refreshStatus === "failed" && val.refreshFailure == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["refreshFailure"],
        message: "refreshStatus 'failed' requires a non-null refreshFailure object",
      });
    }
    if (val.refreshStatus === "degraded" && val.refreshFailure == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["refreshFailure"],
        message: "refreshStatus 'degraded' requires a non-null refreshFailure object",
      });
    }
    if (val.refreshStatus === "ok" && val.refreshFailure != null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["refreshFailure"],
        message: "refreshStatus 'ok' must have refreshFailure null",
      });
    }
  });
