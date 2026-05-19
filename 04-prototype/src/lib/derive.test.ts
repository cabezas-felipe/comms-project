import { describe, expect, it } from "vitest";
import { Source, Story } from "@/data/stories";
import { FRESHNESS_WINDOW_MINUTES, deriveSignals } from "@/lib/derive";

function makeSource(overrides: Partial<Source> = {}): Source {
  return {
    id: overrides.id ?? "src-1",
    outlet: overrides.outlet ?? "Outlet A",
    kind: overrides.kind ?? "traditional",
    weight: overrides.weight ?? 70,
    url: overrides.url ?? "https://example.com",
    minutesAgo: overrides.minutesAgo ?? 0,
    headline: overrides.headline ?? "Headline",
    body: overrides.body ?? ["body"],
    ...overrides,
  };
}

function makeStory(
  sources: Source[],
  overrides: Partial<Story> = {}
): Story {
  return {
    id: overrides.id ?? "story-1",
    title: overrides.title ?? "Story",
    geographies: overrides.geographies ?? ["US"],
    subtitle: overrides.subtitle ?? "",
    summary: overrides.summary ?? "",
    whyItMatters: overrides.whyItMatters ?? "",
    whatChanged: overrides.whatChanged ?? "",
    priority: overrides.priority ?? "standard",
    outletCount: overrides.outletCount ?? sources.length,
    sources,
    ...overrides,
  };
}

/** Build N sources with the freshest at `freshestMinutes` and the rest older. */
function sourcesWithFreshest(count: number, freshestMinutes: number): Source[] {
  return Array.from({ length: count }, (_, i) =>
    makeSource({
      id: `src-${i}`,
      outlet: `Outlet ${i}`,
      minutesAgo: freshestMinutes + i * 30,
    })
  );
}

describe("deriveSignals — 6-hour freshness window", () => {
  it("exports a 360-minute window constant", () => {
    expect(FRESHNESS_WINDOW_MINUTES).toBe(360);
  });

  it("0 minutes → freshness score 100", () => {
    const story = makeStory([makeSource({ minutesAgo: 0 })]);
    // freshnessScore is internal; assert via activityScore with volume held flat.
    // With 1 source: volumeScore = 7, activity = round(100*0.55 + 7*0.45) = 58.
    const signals = deriveSignals(story);
    expect(signals.freshestMinutes).toBe(0);
    expect(signals.activityScore).toBe(58);
  });

  it("360 minutes → freshness score 0 (window edge)", () => {
    const story = makeStory([makeSource({ minutesAgo: 360 })]);
    // volume = 7, freshness = 0 → activity = round(0*0.55 + 7*0.45) = 3
    const signals = deriveSignals(story);
    expect(signals.freshestMinutes).toBe(360);
    expect(signals.activityScore).toBe(3);
  });

  it(">360 minutes clamps freshness at 0", () => {
    const beyond = makeStory([makeSource({ minutesAgo: 600 })]);
    const farBeyond = makeStory([makeSource({ minutesAgo: 5_000 })]);
    // Both should yield the same activity score — freshness component pinned at 0.
    expect(deriveSignals(beyond).activityScore).toBe(
      deriveSignals(farBeyond).activityScore
    );
    expect(deriveSignals(beyond).activityScore).toBe(3);
  });

  it("decays linearly: 180 minutes (halfway) → freshness score ~50", () => {
    // With 1 source: volume = 7, activity = round(50*0.55 + 7*0.45) = 31
    const story = makeStory([makeSource({ minutesAgo: 180 })]);
    expect(deriveSignals(story).activityScore).toBe(31);
  });
});

describe("deriveSignals — trend classification under 6h window", () => {
  it("~60 minutes with decent volume classifies as rising", () => {
    // freshness at 60min: round(100 * (1 - 60/360)) = 83.
    // volume with 8 sources: min(100, 56) = 56.
    // activity = round(83*0.55 + 56*0.45) = round(45.65 + 25.2) = 71 → rising.
    const story = makeStory(sourcesWithFreshest(8, 60));
    const signals = deriveSignals(story);
    expect(signals.activityScore).toBeGreaterThanOrEqual(70);
    expect(signals.trend).toBe("rising");
  });

  it("regression: a 60-min, decent-volume story that was 'steady' under the old 100-min linear scale is now 'rising'", () => {
    // Old formula: freshness = max(0, 100 - 60) = 40.
    //   volume (8 sources) = 56.
    //   activity = round(40*0.55 + 56*0.45) = round(22 + 25.2) = 47 → steady.
    // New formula: activity = 71 → rising.
    // This test locks the behavior change introduced by the 6h window.
    const story = makeStory(sourcesWithFreshest(8, 60));
    expect(deriveSignals(story).trend).toBe("rising");
  });

  it("a stale story (>6h) with high volume falls back to steady, not rising", () => {
    // freshness pinned at 0; volume capped at 100.
    // activity = round(0*0.55 + 100*0.45) = 45 → steady (just at the threshold).
    const story = makeStory(sourcesWithFreshest(20, 400));
    const signals = deriveSignals(story);
    expect(signals.activityScore).toBe(45);
    expect(signals.trend).toBe("steady");
  });

  it("a very stale story with thin volume is falling", () => {
    // freshness 0, volume small → activity < 45.
    const story = makeStory(sourcesWithFreshest(3, 500));
    expect(deriveSignals(story).trend).toBe("falling");
  });
});
