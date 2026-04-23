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
  geographies: ["US" as const],
  topic: "Diplomatic relations" as const,
  takeaway: "Take",
  summary: "Sum",
  whyItMatters: "Why",
  whatChanged: "What",
  priority: "standard" as const,
  outletCount: 2,
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
