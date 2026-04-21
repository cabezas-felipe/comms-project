import { Story, StoryTrustFlag } from "@/lib/story";

const TRUST_FLAG_LABELS: Record<StoryTrustFlag, string> = {
  "missing-major-source": "Missing major-source confirmation",
  "timestamp-stale": "Last update may be stale",
  "low-confidence-summary": "Summary confidence is low",
};

export function formatTrustFlag(flag: StoryTrustFlag): string {
  return TRUST_FLAG_LABELS[flag];
}

export function freshnessLabel(updatedAt: string): "fresh" | "aging" | "stale" {
  const ageMs = Date.now() - new Date(updatedAt).getTime();
  const ageMinutes = ageMs / 60000;

  if (ageMinutes <= 90) {
    return "fresh";
  }

  if (ageMinutes <= 240) {
    return "aging";
  }

  return "stale";
}

export function trustScore(story: Story): number {
  const penalties = story.trustFlags.length * 0.15;
  const freshnessPenalty = freshnessLabel(story.updatedAt) === "stale" ? 0.1 : 0;
  return Math.max(0, Math.round((story.confidence - penalties - freshnessPenalty) * 100));
}
