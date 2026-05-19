import { describe, expect, it } from "vitest";
import {
  CONTRACT_VERSION,
  dashboardPayloadSchema,
  settingsPayloadSchema,
  sourceSchema,
  storySchema,
} from "./schemas.js";

const minimalSource = {
  id: "src1",
  outlet: "Example",
  kind: "traditional" as const,
  weight: 80,
  url: "https://example.com",
  minutesAgo: 10,
  headline: "Headline",
  body: ["Paragraph one."],
};

const minimalStory = {
  id: "s1",
  title: "Title",
  // Meta-story fields PR (Prompt 1): `subtitle` is now required; `takeaway`
  // has been removed from the contract.
  subtitle: "Subtitle.",
  geographies: ["US" as const],
  topic: "Diplomatic relations" as const,
  summary: "Sum",
  whyItMatters: "Why",
  whatChanged: "What",
  priority: "standard" as const,
  outletCount: 2,
  // Phase 2: `tags` is required on every emitted story.  Empty arrays mean
  // "no evidence on this axis" — never fabricated.
  tags: { topics: [], keywords: [], geographies: [] },
  sources: [minimalSource],
};

describe("sourceSchema", () => {
  it("accepts a valid source", () => {
    expect(sourceSchema.parse(minimalSource).id).toBe("src1");
  });

  it("rejects empty url", () => {
    expect(() => sourceSchema.parse({ ...minimalSource, url: "" })).toThrow();
  });
});

describe("storySchema", () => {
  it("rejects a story with missing required fields", () => {
    expect(() =>
      storySchema.parse({ id: "s1", title: "Only a title" })
    ).toThrow();
  });

  it("accepts a minimal valid story", () => {
    const parsed = storySchema.parse(minimalStory);
    expect(parsed.id).toBe("s1");
  });

  // Meta-story fields PR (Prompt 1): `subtitle` is now required on the
  // emitted contract.  Snapshot read adapters lift legacy `takeaway` into
  // `subtitle` before validation, so the strict schema can refuse missing
  // subtitle outright.
  it("rejects a story that omits the subtitle field", () => {
    const { subtitle: _omitted, ...withoutSubtitle } = minimalStory;
    expect(() => storySchema.parse(withoutSubtitle)).toThrow();
  });

  it("strips the legacy takeaway field from emitted payloads", () => {
    const parsed = storySchema.parse({
      ...minimalStory,
      // Extra/legacy key — Zod's default object mode strips unknown fields.
      takeaway: "Should be stripped",
    } as unknown as typeof minimalStory);
    expect(Object.prototype.hasOwnProperty.call(parsed, "takeaway")).toBe(false);
  });

  // Phase 2 trust cleanup: emitted payloads must always carry `tags`.
  // Loaders that surface legacy snapshots are expected to normalize the
  // field to empty arrays before validation — the display contract itself
  // does not accept stories without tags.
  it("rejects a story that omits the tags object", () => {
    const { tags: _omitted, ...withoutTags } = minimalStory;
    expect(() => storySchema.parse(withoutTags)).toThrow();
  });

  it("accepts a story whose tags axes are all empty arrays (no evidence)", () => {
    const parsed = storySchema.parse({
      ...minimalStory,
      tags: { topics: [], keywords: [], geographies: [] },
    });
    expect(parsed.tags).toEqual({ topics: [], keywords: [], geographies: [] });
  });

  it("accepts a story without a canonical topic (Phase 1 fabrication guard)", () => {
    const { topic: _omitted, ...withoutTopic } = minimalStory;
    const parsed = storySchema.parse(withoutTopic);
    expect(parsed.topic).toBeUndefined();
  });
});

describe("dashboardPayloadSchema", () => {
  it("accepts a valid payload with the correct contract version", () => {
    const payload = dashboardPayloadSchema.parse({
      contractVersion: CONTRACT_VERSION,
      stories: [storySchema.parse(minimalStory)],
    });
    expect(payload.stories).toHaveLength(1);
  });

  it("rejects a wrong contract version", () => {
    expect(() =>
      dashboardPayloadSchema.parse({
        contractVersion: "2024-01-01-wrong",
        stories: [],
      })
    ).toThrow();
  });
});

describe("settingsPayloadSchema", () => {
  it("accepts a valid settings payload", () => {
    const parsed = settingsPayloadSchema.parse({
      contractVersion: CONTRACT_VERSION,
      topics: ["Diplomatic relations"],
      keywords: ["OFAC"],
      geographies: ["US"],
      traditionalSources: ["NYT"],
      socialSources: ["@handle"],
    });
    expect(parsed.traditionalSources).toContain("NYT");
  });

  it("rejects a payload missing required topics field", () => {
    expect(() =>
      settingsPayloadSchema.parse({
        contractVersion: CONTRACT_VERSION,
        keywords: ["OFAC"],
        geographies: ["US"],
        traditionalSources: ["NYT"],
        socialSources: ["@handle"],
      })
    ).toThrow();
  });
});
