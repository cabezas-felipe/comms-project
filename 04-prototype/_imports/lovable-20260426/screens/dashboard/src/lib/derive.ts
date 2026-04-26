import { Source, Story } from "@/data/stories";

/**
 * Derived signals computed from the same underlying story data.
 * No new entities — just different lenses on the same source list,
 * outlet count, timing, and "what changed" text.
 */

export type Trend = "rising" | "steady" | "falling";
export type Confidence = "high" | "medium" | "early";

export interface DerivedSignals {
  /** Median minutes since publication across sources */
  medianMinutes: number;
  /** Newest source minutes */
  freshestMinutes: number;
  /** 0-100 activity score from outletCount + freshness */
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

  // Activity: more outlets + fresher = higher
  const freshnessScore = Math.max(0, 100 - freshestMinutes); // 0-100
  const volumeScore = Math.min(100, story.outletCount * 7);
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

  const recommendedAction =
    story.priority === "top"
      ? story.topic === "Diplomatic relations"
        ? "Draft holding statement; align with policy lead before next cycle."
        : story.topic === "Migration policy"
        ? "Prepare bilateral Q&A; confirm spokesperson availability within 4h."
        : "Brief leadership; pre-clear two response options."
      : story.topic === "Diplomatic relations"
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
