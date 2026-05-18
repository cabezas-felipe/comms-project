import { Source, Story } from "@/data/stories";

/**
 * Derived signals computed from the same underlying story data.
 * No new entities — just different lenses on the same source list,
 * outlet count, timing, and "what changed" text.
 */

export type Trend = "rising" | "steady" | "falling";
export type Confidence = "high" | "medium" | "early";

/**
 * Freshness decays linearly over a 6-hour window. A story whose newest
 * source is older than this scores 0 on the freshness axis, regardless of
 * how much older.
 */
export const FRESHNESS_WINDOW_MINUTES = 6 * 60;

export interface DerivedSignals {
  /** Median minutes since publication across sources */
  medianMinutes: number;
  /** Newest source minutes */
  freshestMinutes: number;
  /** 0-100 activity score from total source pieces + freshness */
  activityScore: number;
  trend: Trend;
  /** 0-100 confidence from source count + outlet diversity */
  confidence: Confidence;
  confidenceScore: number;
  /** Distinct outlet families (proxy: distinct outlets) */
  outletDiversity: number;
  /** A short, deterministic recommended action derived from priority + topic */
  recommendedAction: string;
  /** Decision posture for analyst view */
  posture: "Prepare statement" | "Monitor" | "Brief leadership" | "Hold";
}

export function deriveSignals(story: Story): DerivedSignals {
  const mins = story.sources.map((s) => s.minutesAgo).sort((a, b) => a - b);
  const medianMinutes = mins[Math.floor(mins.length / 2)] ?? 0;
  const freshestMinutes = mins[0] ?? 0;

  // Activity: more coverage + fresher = higher. Volume uses total pieces
  // (sources.length) so the bar reflects "how much coverage" while the
  // collapsed chip separately reports unique source identities.
  const freshnessRatio = Math.min(1, freshestMinutes / FRESHNESS_WINDOW_MINUTES);
  const freshnessScore = Math.round(Math.max(0, 100 * (1 - freshnessRatio))); // 0-100
  const volumeScore = Math.min(100, story.sources.length * 7);
  const activityScore = Math.round(freshnessScore * 0.55 + volumeScore * 0.45);

  const trend: Trend =
    activityScore >= 70 ? "rising" : activityScore >= 45 ? "steady" : "falling";

  const outletDiversity = new Set(story.sources.map((s) => s.outlet)).size;
  const confidenceScore = Math.min(
    100,
    outletDiversity * 18 + story.sources.length * 6
  );
  const confidence: Confidence =
    confidenceScore >= 70 ? "high" : confidenceScore >= 45 ? "medium" : "early";

  // Phase 6: recommended-action copy reads from `story.tags.topics` only —
  // never from the legacy root `story.topic` field.  Phase 1 made root
  // `topic` optional and non-authoritative for UI; this analyst copy was the
  // last remaining UI consumer.  The case branching uses *presence* of a
  // canonical topic in the tag set instead of equality on the (possibly
  // undefined) root field.  When the tag set is empty, we fall through to
  // the neutral copy — same posture as Phase 1/2 when no evidence supports
  // a canonical topic.
  const tagTopicSet = new Set(story.tags?.topics ?? []);
  const hasDiplomaticTopic = tagTopicSet.has("Diplomatic relations");
  const hasMigrationTopic = tagTopicSet.has("Migration policy");
  const recommendedAction =
    story.priority === "top"
      ? hasDiplomaticTopic
        ? "Draft holding statement; align with policy lead before next cycle."
        : hasMigrationTopic
        ? "Prepare bilateral Q&A; confirm spokesperson availability within 4h."
        : "Brief leadership; pre-clear two response options."
      : hasDiplomaticTopic
      ? "Maintain baseline summary; revisit if a tier-1 outlet reframes."
      : "Track through next refresh; no action required yet.";

  const posture: DerivedSignals["posture"] =
    story.priority === "top" && activityScore >= 70
      ? "Prepare statement"
      : story.priority === "top"
      ? "Brief leadership"
      : activityScore >= 60
      ? "Monitor"
      : "Hold";

  return {
    medianMinutes,
    freshestMinutes,
    activityScore,
    trend,
    confidence,
    confidenceScore,
    outletDiversity,
    recommendedAction,
    posture,
  };
}

/**
 * Return up to n sources ranked by weight, then by recency.
 */
export function keySources(story: Story, n = 5): Source[] {
  return [...story.sources]
    .sort((a, b) => {
      if (b.weight !== a.weight) return b.weight - a.weight;
      return a.minutesAgo - b.minutesAgo;
    })
    .slice(0, n);
}
