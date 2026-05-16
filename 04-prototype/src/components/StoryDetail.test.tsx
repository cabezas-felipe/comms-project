import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import StoryDetail from "@/components/StoryDetail";
import type { Source, Story } from "@/data/stories";

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
    summary: "Summary text",
    whyItMatters: "Why",
    whatChanged: "What changed",
    priority: "standard",
    outletCount: 1,
    sources: [makeSource()],
    ...overrides,
  };
}

function renderDetail(story: Story) {
  return render(<StoryDetail story={story} onClose={vi.fn()} />);
}

describe("StoryDetail: Phase 6 chip row is tags-only", () => {
  it("renders the topic chip from story.tags.topics[0] when present (not story.topic)", () => {
    const story = makeStory({
      topic: "Diplomatic relations", // root field — must NOT power the chip
      tags: {
        topics: ["Migration policy"], // tag-source winner
        keywords: [],
        geographies: ["US", "Colombia"],
      },
    });
    renderDetail(story);
    // Chip shows the tag, not the root field.
    expect(screen.getByText("Migration policy")).toBeInTheDocument();
    expect(screen.queryByText("Diplomatic relations")).not.toBeInTheDocument();
    expect(screen.getByTestId("story-detail-tag-row")).toBeInTheDocument();
  });

  it("renders geos from story.tags.geographies (not story.geographies)", () => {
    const story = makeStory({
      geographies: ["US"], // root — must be ignored
      tags: { topics: [], keywords: [], geographies: ["Colombia"] },
    });
    renderDetail(story);
    expect(screen.getByText("CO")).toBeInTheDocument();
    expect(screen.queryByText("US")).not.toBeInTheDocument();
  });

  it("renders an alias-driven geography (e.g. 'China') even though the type isn't the legacy enum", () => {
    // Phase 3 alias map can surface settings labels outside the original
    // canonical pair (US / Colombia).  The detail chip row must render the
    // settings spelling verbatim (uppercased by GeoTag).
    const story = makeStory({
      tags: { topics: [], keywords: [], geographies: ["China"] },
    });
    renderDetail(story);
    expect(screen.getByText("CHINA")).toBeInTheDocument();
  });

  it("hides the chip row entirely when both topic and geographies tags are empty (no orphan divider)", () => {
    const story = makeStory({
      topic: "Diplomatic relations", // root present
      geographies: ["US", "Colombia"], // root present
      tags: { topics: [], keywords: [], geographies: [] }, // no tags
    });
    renderDetail(story);
    expect(screen.queryByTestId("story-detail-tag-row")).not.toBeInTheDocument();
    // And no leakage of root fields into the heading area.
    expect(screen.queryByText("Diplomatic relations")).not.toBeInTheDocument();
  });

  it("omits the `|` divider when only one axis has tags", () => {
    const story = makeStory({
      tags: { topics: ["Migration policy"], keywords: [], geographies: [] },
    });
    renderDetail(story);
    expect(screen.getByText("Migration policy")).toBeInTheDocument();
    // The pipe character should not appear adjacent to the topic chip.
    expect(screen.queryByText("|")).not.toBeInTheDocument();
  });

  it("renders the `|` divider only when BOTH the topic chip and the geo strip are present", () => {
    const story = makeStory({
      tags: {
        topics: ["Diplomatic relations"],
        keywords: [],
        geographies: ["US"],
      },
    });
    renderDetail(story);
    expect(screen.getByText("Diplomatic relations")).toBeInTheDocument();
    expect(screen.getByText("US")).toBeInTheDocument();
    expect(screen.getByText("|")).toBeInTheDocument();
  });

  it("does NOT surface any semantic diagnostic field in the rendered output", () => {
    // Defensive: even if a future change accidentally passes diagnostics
    // through, the rendered output must not contain operator-only strings.
    const story = makeStory({
      tags: { topics: ["Diplomatic relations"], keywords: [], geographies: ["US"] },
    });
    renderDetail(story);
    expect(screen.queryByText(/runtimeState/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/scorerLatencyMs/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/belowThresholdCount/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/semanticApplied/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/fallbackReasonCounts/i)).not.toBeInTheDocument();
  });
});
