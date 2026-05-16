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

export const CONTRACT_VERSION = "2026-04-22-slice1";

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
  subtitle: z.string().optional(),
  geographies: z.array(geographySchema),
  topic: topicSchema.optional(),
  takeaway: z.string().min(1),
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

export const settingsPayloadSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  topics: z.array(z.string().min(1)),
  keywords: z.array(z.string().min(1)),
  geographies: z.array(z.string().min(1)),
  traditionalSources: z.array(z.string().min(1)),
  socialSources: z.array(z.string().min(1)),
});
