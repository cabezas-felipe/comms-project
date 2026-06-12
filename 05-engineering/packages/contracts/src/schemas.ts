import { z } from "zod";

/** API / persistence contract version for migrations and clients. */
export const CONTRACT_VERSION = "2026-05-19-meta-story-fields" as const;

export const geographySchema = z.enum(["US", "Colombia"]);
export const topicSchema = z.enum([
  "Diplomatic relations",
  "Migration policy",
  "Security cooperation",
]);
export const sourceKindSchema = z.enum(["traditional", "social"]);
export const storyPrioritySchema = z.enum(["top", "standard"]);
export const trendSchema = z.enum(["rising", "steady", "falling"]);

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
  // Meta-story fields PR (Prompt 1): `subtitle` is now required (one-sentence
  // contextual placement of the story).  Replaces the legacy `takeaway` field
  // which has been removed from the emitted contract.  Legacy snapshots that
  // still carry `takeaway` are migrated at the snapshot read boundary (see
  // `dashboard-snapshot-repo.mjs`).
  subtitle: z.string().min(1),
  // Phase 2 trust cleanup: root `geographies` and `topic` are retained on the
  // wire for historic clients but are NOT authoritative for UI labels/filters.
  // The dashboard reads all topic/keyword/geography pills out of `tags`; these
  // root fields are kept only to preserve back-compat of the response shape
  // (and lineage code on the API side, which still keys narrative continuity
  // by canonical topic).  See `04-prototype/src/lib/dashboard-filters.ts` and
  // `05-engineering/docs/dashboard-story-pool-spec.md` (Chunk K).
  geographies: z.array(geographySchema),
  topic: topicSchema.optional(),
  summary: z.string().min(1),
  whyItMatters: z.string().min(1),
  whatChanged: z.string().min(1),
  priority: storyPrioritySchema,
  outletCount: z.number().int().nonnegative(),
  // Phase 2: `tags` is required on emitted payloads.  Each axis is a string
  // array; an empty array means "no evidence on this axis" (never fabricated).
  // Loaders that surface older snapshots (which may lack the field) MUST
  // normalize at the API boundary before validation — display schema stays
  // strict so the UI can assume the shape.
  tags: storyTagsSchema,
  sources: z.array(sourceSchema).min(1),
});

export const dashboardPayloadSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  stories: z.array(storySchema),
});

/**
 * Selection metadata surfaced through `_meta.selection` on dashboard responses
 * (Phase 2).  Reports source-resolution outcome so the frontend can show small
 * status cues (fallback used / unmatched names / strict-empty).  All fields
 * are optional for forward compatibility — older snapshots won't carry them.
 */
export const dashboardSelectionMetaSchema = z.object({
  sourceSelectionMode: z.enum(["strict", "fallback"]).optional(),
  sourceFallbackUsed: z.boolean().optional(),
  sourceFallbackReason: z.string().nullable().optional(),
  matchedSourceCount: z.number().int().nonnegative().optional(),
  selectedSourceCount: z.number().int().nonnegative().optional(),
  unmatchedSelectedSources: z.array(z.string()).optional(),
  unavailableConnectorCount: z.number().int().nonnegative().optional(),
  unavailableConnectorSources: z.array(z.string()).optional(),
  matchedFeedIds: z.array(z.string()).optional(),
  relevantItemCount: z.number().int().nonnegative().optional(),
});

/**
 * Per-dropped-candidate scoring breakdown for `_meta.clusterCap.clusterDropped`
 * (Phase 1 Step 1.4 diagnostics). Each numeric component is `number | null` —
 * null only when a non-finite value was coerced for clean JSON, so debug tooling
 * can render the component grid without guarding every cell.
 */
export const dashboardClusterDroppedComponentsSchema = z.object({
  topicFit: z.number().nullable(),
  keywordFit: z.number().nullable(),
  geoFit: z.number().nullable(),
  entityFit: z.number().nullable(),
  corroboration: z.number().nullable(),
  beatFit: z.number().nullable(),
  freshness: z.number().nullable(),
  electionGeoBoost: z.number().nullable(),
});

/**
 * One explained cluster-input-cap drop. Carries the source identity, a
 * (truncated) headline, its absolute 1-based rank in the full ranked list, the
 * composite `preClusterScore`, the component breakdown, and the Decision-5C
 * election-geo classification plus geo-fit reasons. Nullable fields degrade
 * gracefully when a signal was unavailable for that item.
 */
export const dashboardClusterDroppedEntrySchema = z.object({
  sourceId: z.string().nullable(),
  headline: z.string(),
  rank: z.number(),
  preClusterScore: z.number().nullable(),
  components: dashboardClusterDroppedComponentsSchema,
  electionGeoClass: z
    .enum(["configuredGeoElection", "crossCountryElection", "nonElection"])
    .nullable(),
  hardFail: z.boolean().nullable(),
  geoReason: z.string().nullable(),
  geoCategory: z.string().nullable(),
  headlineFamilyKey: z.string().nullable(),
});

/**
 * Cluster-input-cap diagnostics surfaced through `_meta.clusterCap` on dashboard
 * responses (C1). The four count/id fields are the stable, required surface that
 * existing clients already read; `clusterDropped` (Step 1.4) and
 * `clusterInputCapEffective` (Slice 3) are ADDITIVE optionals — older snapshots
 * that predate them still validate. `clusterDropped` is a bounded list (≤10) of
 * explained drops in drop-rank order, matching `clusterDroppedSourceIds`.
 */
export const dashboardClusterCapMetaSchema = z.object({
  dedupedCount: z.number().int().nonnegative(),
  clusterInputCount: z.number().int().nonnegative(),
  clusterDroppedCount: z.number().int().nonnegative(),
  clusterDroppedSourceIds: z.array(z.string()),
  clusterDropped: z.array(dashboardClusterDroppedEntrySchema).optional(),
  clusterInputCapEffective: z.number().int().positive().optional(),
});

/**
 * Refresh fail-safe contract (Phase 4 · Step 2) surfaced on `_meta` of a
 * dashboard refresh response. Lets clients distinguish a TRUE quiet/empty
 * success from a refresh failure that ALSO returns `stories: []` (e.g. a
 * clustering fail-closed run). ADDITIVE: older clients that don't read these
 * keys are unaffected; the rest of `_meta` is unchanged.
 *
 *   refreshStatus      "ok" | "failed"
 *   refreshFailure     null when ok; the structured failure when failed
 *   usedPriorSnapshot  true when the served stories came from a preserved prior
 *                      snapshot (failure-driven continuity), false otherwise
 *
 * `subtype` is the stable WIRE vocabulary, decoupled from the pipeline's
 * internal naming (the API maps internal "timeout_budget" → "timeout").
 * `retryAfterMs` / `nextRetryAt` are OPTIONAL — present only when retry timing
 * is known; omitted otherwise (immediate in-pipeline retries carry no schedule).
 */
export const refreshFailureSubtypeSchema = z.enum([
  "parse",
  "timeout",
  "provider_request",
  "unknown",
]);

export const refreshFailureSchema = z.object({
  reason: z.string().min(1),
  subtype: refreshFailureSubtypeSchema,
  // `attempts` is `>= 1`: a refreshFailure object only exists on a FAILED refresh,
  // and a failure represents at least one attempted run (the API floors it to 1).
  // Pinning `positive()` here keeps the Step 2 floor honest at the contract level.
  attempts: z.number().int().positive(),
  retryable: z.boolean(),
  retryAfterMs: z.number().int().nonnegative().optional(),
  nextRetryAt: z.string().min(1).optional(),
});

export const dashboardRefreshFailsafeMetaSchema = z
  .object({
    refreshStatus: z.enum(["ok", "failed"]),
    // null (not absent) on success — a single, explicit shape clients can rely on.
    refreshFailure: refreshFailureSchema.nullable(),
    usedPriorSnapshot: z.boolean(),
  })
  // `_meta` carries many other diagnostic keys alongside these — passthrough so
  // a full `_meta` object validates against the fail-safe surface additively.
  .passthrough()
  // Invariant pinned by Step 4: status and failure object are coupled — a
  // "failed" refresh ALWAYS carries a structured refreshFailure, and an "ok"
  // refresh NEVER does (refreshFailure is null on success). The API honors both
  // directions; this rejects contradictory payloads outright.
  .superRefine((val, ctx) => {
    if (val.refreshStatus === "failed" && val.refreshFailure == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["refreshFailure"],
        message: "refreshStatus 'failed' requires a non-null refreshFailure object",
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

export const settingsPayloadSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  topics: z.array(z.string().min(1)),
  keywords: z.array(z.string().min(1)),
  geographies: z.array(z.string().min(1)),
  traditionalSources: z.array(z.string().min(1)),
  socialSources: z.array(z.string().min(1)),
});

export type GeographyDto = z.infer<typeof geographySchema>;
export type TopicDto = z.infer<typeof topicSchema>;
export type SourceKindDto = z.infer<typeof sourceKindSchema>;
export type StoryPriorityDto = z.infer<typeof storyPrioritySchema>;
export type TrendDto = z.infer<typeof trendSchema>;
export type SourceDto = z.infer<typeof sourceSchema>;
export type StoryTagsDto = z.infer<typeof storyTagsSchema>;
export type StoryDto = z.infer<typeof storySchema>;
export type DashboardPayload = z.infer<typeof dashboardPayloadSchema>;
export type DashboardSelectionMeta = z.infer<typeof dashboardSelectionMetaSchema>;
export type DashboardClusterDroppedComponents = z.infer<
  typeof dashboardClusterDroppedComponentsSchema
>;
export type DashboardClusterDroppedEntry = z.infer<typeof dashboardClusterDroppedEntrySchema>;
export type DashboardClusterCapMeta = z.infer<typeof dashboardClusterCapMetaSchema>;
export type RefreshFailureSubtype = z.infer<typeof refreshFailureSubtypeSchema>;
export type RefreshFailure = z.infer<typeof refreshFailureSchema>;
export type DashboardRefreshFailsafeMeta = z.infer<typeof dashboardRefreshFailsafeMetaSchema>;
export type SettingsPayload = z.infer<typeof settingsPayloadSchema>;
