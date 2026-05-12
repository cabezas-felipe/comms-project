import { describe, expect, it } from "vitest";
import {
  aggregateTagSections,
  isEmptySelection,
  storyMatchesSelection,
  storyScanLabels,
  toggleInSet,
  type TagSelection,
} from "./dashboard-filters";
import type { Story } from "@/data/stories";

function makeStory(overrides: Partial<Story> = {}): Story {
  return {
    id: "s",
    title: "T",
    geographies: ["US"],
    topic: "Diplomatic relations",
    takeaway: "k",
    summary: "s",
    whyItMatters: "w",
    whatChanged: "c",
    priority: "standard",
    outletCount: 1,
    sources: [],
    ...overrides,
  };
}

/** Test-only: story shape missing `topic` for scan-label edge cases. */
function storyWithoutTopic(overrides: Partial<Story> = {}): Story {
  const base = makeStory(overrides);
  const { topic: _t, ...rest } = base;
  return rest as Story;
}

function selection(t: string[] = [], k: string[] = [], g: string[] = []): TagSelection {
  return { topics: new Set(t), keywords: new Set(k), geographies: new Set(g) };
}

describe("aggregateTagSections", () => {
  it("returns sorted unique values across stories' tags", () => {
    const stories = [
      makeStory({
        id: "a",
        tags: {
          topics: ["Migration policy", "Diplomatic relations"],
          keywords: ["sanctions", "OFAC"],
          geographies: ["US", "Colombia"],
        },
      }),
      makeStory({
        id: "b",
        tags: {
          topics: ["Migration policy"],
          keywords: ["asylum"],
          geographies: ["US"],
        },
      }),
    ];
    const sections = aggregateTagSections(stories);
    expect(sections.topics).toEqual(["Diplomatic relations", "Migration policy"]);
    expect(sections.keywords).toEqual(["asylum", "OFAC", "sanctions"]);
    expect(sections.geographies).toEqual(["Colombia", "US"]);
  });

  it("falls back to story.topic and story.geographies when tags are absent", () => {
    const stories = [
      makeStory({ id: "a", topic: "Diplomatic relations", geographies: ["US"] }),
      makeStory({ id: "b", topic: "Security cooperation", geographies: ["Colombia"] }),
    ];
    const sections = aggregateTagSections(stories);
    expect(sections.topics).toEqual(["Diplomatic relations", "Security cooperation"]);
    expect(sections.geographies).toEqual(["Colombia", "US"]);
    // Keywords are NEVER inferred — section stays empty without tags
    expect(sections.keywords).toEqual([]);
  });

  it("returns empty sections for an empty story list", () => {
    const sections = aggregateTagSections([]);
    expect(sections.topics).toEqual([]);
    expect(sections.keywords).toEqual([]);
    expect(sections.geographies).toEqual([]);
  });

  it("deduplicates across stories", () => {
    const stories = [
      makeStory({ id: "a", tags: { topics: ["X"], keywords: ["k"], geographies: ["US"] } }),
      makeStory({ id: "b", tags: { topics: ["X"], keywords: ["k"], geographies: ["US"] } }),
    ];
    const sections = aggregateTagSections(stories);
    expect(sections.topics).toEqual(["X"]);
    expect(sections.keywords).toEqual(["k"]);
    expect(sections.geographies).toEqual(["US"]);
  });
});

describe("storyMatchesSelection", () => {
  const story = makeStory({
    tags: {
      topics: ["Diplomatic relations"],
      keywords: ["sanctions", "OFAC"],
      geographies: ["US", "Colombia"],
    },
  });

  it("passes any story when selection is empty across all sections", () => {
    expect(storyMatchesSelection(story, selection())).toBe(true);
  });

  it("OR within section — any match suffices", () => {
    expect(storyMatchesSelection(story, selection([], ["sanctions", "asylum"]))).toBe(true);
  });

  it("OR within section — none matches → false", () => {
    expect(storyMatchesSelection(story, selection([], ["asylum"]))).toBe(false);
  });

  it("AND across sections — all selected sections must individually match", () => {
    // Topics OK + keywords OK + geo OK
    expect(storyMatchesSelection(story, selection(["Diplomatic relations"], ["OFAC"], ["US"]))).toBe(true);
    // Topics OK + keywords miss → false
    expect(storyMatchesSelection(story, selection(["Diplomatic relations"], ["asylum"], ["US"]))).toBe(false);
  });

  it("falls back to story.topic when tags are absent for topics", () => {
    const legacy = makeStory({ topic: "Migration policy", tags: undefined });
    expect(storyMatchesSelection(legacy, selection(["Migration policy"]))).toBe(true);
    expect(storyMatchesSelection(legacy, selection(["Diplomatic relations"]))).toBe(false);
  });

  it("falls back to story.geographies when tags are absent for geographies", () => {
    const legacy = makeStory({ geographies: ["Colombia"], tags: undefined });
    expect(storyMatchesSelection(legacy, selection([], [], ["Colombia"]))).toBe(true);
    expect(storyMatchesSelection(legacy, selection([], [], ["US"]))).toBe(false);
  });

  it("rejects keyword selection when story has no tags (no inference from free text)", () => {
    const legacy = makeStory({ summary: "OFAC mentioned in summary text", tags: undefined });
    expect(storyMatchesSelection(legacy, selection([], ["OFAC"]))).toBe(false);
  });
});

describe("isEmptySelection", () => {
  it("true when all three sets are empty", () => {
    expect(isEmptySelection(selection())).toBe(true);
  });

  it("false when any set has entries", () => {
    expect(isEmptySelection(selection(["Diplomatic relations"]))).toBe(false);
    expect(isEmptySelection(selection([], ["k"]))).toBe(false);
    expect(isEmptySelection(selection([], [], ["US"]))).toBe(false);
  });
});

describe("storyScanLabels", () => {
  it("returns the two alphabetically first topics when ≥2 topics exist", () => {
    const story = makeStory({
      tags: {
        topics: ["Migration policy", "Diplomatic relations", "Security cooperation"],
        keywords: ["sanctions"],
        geographies: ["US"],
      },
    });
    expect(storyScanLabels(story)).toEqual(["Diplomatic relations", "Migration policy"]);
  });

  it("returns the two alphabetically first keywords when ≥2 keywords and <2 topics", () => {
    const keywords = ["sanctions", "asylum", "OFAC"];
    const story = makeStory({
      tags: {
        topics: [],
        keywords,
        geographies: ["US"],
      },
    });
    const sorted = [...new Set(keywords)].sort((a, b) => a.localeCompare(b));
    expect(storyScanLabels(story)).toEqual(sorted.slice(0, 2));
  });

  it("returns [topic, keyword] in fixed section order when one of each", () => {
    const story = makeStory({
      tags: {
        topics: ["Migration policy"],
        keywords: ["sanctions"],
        geographies: ["US", "Colombia"],
      },
    });
    expect(storyScanLabels(story)).toEqual(["Migration policy", "sanctions"]);
  });

  it("returns single topic when only one topic and no keywords", () => {
    const story = makeStory({
      tags: {
        topics: ["Diplomatic relations"],
        keywords: [],
        geographies: ["US"],
      },
    });
    expect(storyScanLabels(story)).toEqual(["Diplomatic relations"]);
  });

  it("returns single keyword when only one keyword and no topics", () => {
    const story = storyWithoutTopic({
      tags: {
        topics: [],
        keywords: ["sanctions"],
        geographies: ["US"],
      },
    });
    expect(storyScanLabels(story)).toEqual(["sanctions"]);
  });

  it("falls back to story.topic when tags are absent", () => {
    const legacy = makeStory({ topic: "Diplomatic relations", tags: undefined });
    expect(storyScanLabels(legacy)).toEqual(["Diplomatic relations"]);
  });

  it("dedupes topics and keywords before counting/sorting", () => {
    const story = makeStory({
      tags: {
        topics: ["Migration policy", "Migration policy"],
        keywords: ["sanctions", "sanctions"],
        geographies: ["US"],
      },
    });
    // After dedupe: 1 topic, 1 keyword → priority 3 (topic + keyword)
    expect(storyScanLabels(story)).toEqual(["Migration policy", "sanctions"]);
  });

  // Geographies are intentionally ignored on the scan row. With no topic
  // fallback and empty topics/keywords tags, T and K are both empty → [].
  it("never includes geography on the scan row", () => {
    const story = storyWithoutTopic({
      tags: {
        topics: [],
        keywords: [],
        geographies: ["US", "Colombia"],
      },
    });
    expect(storyScanLabels(story)).toEqual([]);
  });

  // No `story.topic` (so no topic fallback) and no `tags` at all → there is
  // simply no topics/keywords evidence to draw on, so the scan row is empty.
  it("returns an empty array when no topics or keywords are available", () => {
    const story = storyWithoutTopic({ tags: undefined });
    expect(storyScanLabels(story)).toEqual([]);
  });
});

describe("toggleInSet", () => {
  it("adds when absent and removes when present (immutably)", () => {
    const initial = new Set<string>(["a"]);
    const added = toggleInSet(initial, "b");
    expect([...added].sort()).toEqual(["a", "b"]);
    expect(initial.has("b")).toBe(false); // immutability

    const removed = toggleInSet(added, "a");
    expect([...removed]).toEqual(["b"]);
  });
});
