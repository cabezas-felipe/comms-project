import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import StoryCard from "@/components/StoryCard";
import type { Source, Story } from "@/data/stories";
import type { DerivedSignals } from "@/lib/derive";

function makeSource(overrides: Partial<Source> = {}): Source {
  return {
    id: "src-1",
    outlet: "Reuters",
    kind: "traditional",
    weight: 50,
    url: "#",
    minutesAgo: 10,
    headline: "h",
    body: ["b"],
    ...overrides,
  };
}

function makeStory(overrides: Partial<Story> = {}): Story {
  return {
    id: "s",
    title: "Title",
    geographies: ["US"],
    topic: "Diplomatic relations",
    takeaway: "k",
    summary: "s",
    whyItMatters: "w",
    whatChanged: "c",
    priority: "standard",
    outletCount: 1,
    sources: [makeSource()],
    ...overrides,
  };
}

function makeSignals(overrides: Partial<DerivedSignals> = {}): DerivedSignals {
  return {
    medianMinutes: 10,
    freshestMinutes: 10,
    activityScore: 50,
    trend: "steady",
    confidence: "early",
    confidenceScore: 30,
    outletDiversity: 1,
    recommendedAction: "—",
    posture: "Monitor",
    ...overrides,
  };
}

function renderCard(story: Story, expanded = false) {
  return render(
    <StoryCard
      story={story}
      sig={makeSignals()}
      expanded={expanded}
      onToggle={vi.fn()}
      onOpenSource={vi.fn()}
    />
  );
}

describe("StoryCard collapsed chip", () => {
  it("renders unique source identities as `{n} sources`, not outlets", () => {
    const story = makeStory({
      // 4 source rows, but only 2 unique outlets ("Reuters" + "AP")
      outletCount: 99, // intentionally wrong to prove we don't surface it
      sources: [
        makeSource({ id: "a", outlet: "Reuters" }),
        makeSource({ id: "b", outlet: "Reuters" }),
        makeSource({ id: "c", outlet: "AP" }),
        makeSource({ id: "d", outlet: "AP" }),
      ],
    });
    renderCard(story);
    expect(screen.getByText("2 sources")).toBeInTheDocument();
    expect(screen.queryByText(/outlets/)).not.toBeInTheDocument();
    expect(screen.queryByText(/99/)).not.toBeInTheDocument();
  });

  it("counts each row when every outlet is distinct", () => {
    const story = makeStory({
      sources: [
        makeSource({ id: "a", outlet: "Reuters" }),
        makeSource({ id: "b", outlet: "AP" }),
        makeSource({ id: "c", outlet: "Bloomberg" }),
      ],
    });
    renderCard(story);
    expect(screen.getByText("3 sources")).toBeInTheDocument();
  });

  it("collapses case + whitespace variants of the same outlet to one source", () => {
    const story = makeStory({
      sources: [
        makeSource({ id: "a", outlet: "Reuters" }),
        makeSource({ id: "b", outlet: "reuters " }),
        makeSource({ id: "c", outlet: "REUTERS" }),
        makeSource({ id: "d", outlet: "  Reuters" }),
        // distinct identity should still increment the count
        makeSource({ id: "e", outlet: "AP" }),
      ],
    });
    renderCard(story);
    expect(screen.getByText("2 sources")).toBeInTheDocument();
  });

  it("collapses internal-whitespace variants of the same outlet", () => {
    const story = makeStory({
      sources: [
        makeSource({ id: "a", outlet: "The New York Times" }),
        makeSource({ id: "b", outlet: "The  New   York Times" }),
      ],
    });
    renderCard(story);
    expect(screen.getByText("1 sources")).toBeInTheDocument();
  });

  it("does not count blank or whitespace-only outlets as a source", () => {
    const story = makeStory({
      sources: [
        makeSource({ id: "a", outlet: "Reuters" }),
        makeSource({ id: "b", outlet: "" }),
        makeSource({ id: "c", outlet: "   " }),
        makeSource({ id: "d", outlet: "\t\n" }),
      ],
    });
    renderCard(story);
    expect(screen.getByText("1 sources")).toBeInTheDocument();
  });

  it("reports 0 sources when every outlet string is blank", () => {
    const story = makeStory({
      sources: [
        makeSource({ id: "a", outlet: "" }),
        makeSource({ id: "b", outlet: "   " }),
      ],
    });
    renderCard(story);
    expect(screen.getByText("0 sources")).toBeInTheDocument();
  });
});

describe("StoryCard expanded header", () => {
  it("shows only `Key stories` (no count) when totalPieces <= 5", () => {
    const story = makeStory({
      sources: Array.from({ length: 5 }, (_, i) =>
        makeSource({ id: `src-${i}`, outlet: `Outlet${i}` })
      ),
    });
    renderCard(story, true);
    expect(screen.getByText("Key stories")).toBeInTheDocument();
    expect(screen.queryByText(/top\s+\d+\s+of\s+\d+/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/outlets/)).not.toBeInTheDocument();
  });

  it("shows `Key stories · top 5 of N` when totalPieces >= 6", () => {
    const story = makeStory({
      sources: Array.from({ length: 8 }, (_, i) =>
        makeSource({ id: `src-${i}`, outlet: `Outlet${i}` })
      ),
    });
    renderCard(story, true);
    expect(screen.getByText("Key stories · top 5 of 8")).toBeInTheDocument();
    expect(screen.queryByText(/outlets/)).not.toBeInTheDocument();
  });

  it("never renders the legacy `of N outlets` line", () => {
    const story = makeStory({
      outletCount: 42,
      sources: Array.from({ length: 7 }, (_, i) =>
        makeSource({ id: `src-${i}`, outlet: `Outlet${i}` })
      ),
    });
    renderCard(story, true);
    expect(screen.queryByText(/of\s+42\s+outlets/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Key sources/i)).not.toBeInTheDocument();
  });
});

// ─── Phase 6: scan-row + chip behavior is tags-only ────────────────────────
//
// The status row above the headline ("rising · {scan labels}") must source
// labels from `story.tags` only.  Root `story.topic` / `story.geographies`
// are no longer authoritative for UI; Phase 1 already removed the
// fallback inside `storyScanLabels`, and these tests pin that semantics
// stay tag-only at the rendered-component level.

describe("Phase 6: scan-row is tags-only", () => {
  it("renders no scan-row labels when story has tags but they are all empty (no fallback to root topic)", () => {
    const story = makeStory({
      topic: "Diplomatic relations", // root field — must NOT light up the scan row
      geographies: ["US"],
      tags: { topics: [], keywords: [], geographies: [] },
    });
    renderCard(story);
    // The trend label always renders; the optional scan-row labels appear
    // after a "·" separator.  Asserting no separator after the trend label
    // is the cleanest way to verify nothing from root fields leaked.
    expect(screen.queryByText("Diplomatic relations")).not.toBeInTheDocument();
  });

  it("renders no scan-row labels when story has no tags object (legacy/missing — defensive)", () => {
    const story = makeStory({
      topic: "Diplomatic relations",
      geographies: ["US"],
      tags: undefined,
    });
    renderCard(story);
    expect(screen.queryByText("Diplomatic relations")).not.toBeInTheDocument();
  });

  it("renders scan-row labels exclusively from story.tags when present", () => {
    const story = makeStory({
      topic: "Diplomatic relations", // root — must be IGNORED
      tags: {
        topics: ["Migration policy"], // tag-source winner
        keywords: ["OFAC"],
        geographies: ["US"],
      },
    });
    renderCard(story);
    // Scan-row priority is "1 topic + 1 keyword" → [topic, keyword].
    expect(screen.getByText(/Migration policy/)).toBeInTheDocument();
    expect(screen.getByText(/OFAC/)).toBeInTheDocument();
    // The root topic must not appear on the card.
    expect(screen.queryByText("Diplomatic relations")).not.toBeInTheDocument();
  });
});
