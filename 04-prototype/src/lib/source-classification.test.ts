import { describe, expect, it } from "vitest";
import { classifySources } from "@/lib/source-classification";

describe("classifySources", () => {
  // ── empty input ─────────────────────────────────────────────────────────────

  it("returns empty arrays for empty input", () => {
    expect(classifySources([])).toEqual({ traditionalSources: [], socialSources: [] });
  });

  it("skips blank and whitespace-only entries", () => {
    expect(classifySources(["", "   ", "\t"])).toEqual({
      traditionalSources: [],
      socialSources: [],
    });
  });

  // ── traditional classification ───────────────────────────────────────────────

  it("classifies plain outlet names as traditional", () => {
    const { traditionalSources, socialSources } = classifySources(["Reuters", "NYT"]);
    expect(traditionalSources).toEqual(["Reuters", "NYT"]);
    expect(socialSources).toEqual([]);
  });

  it("classifies multi-word outlet names as traditional", () => {
    const { traditionalSources } = classifySources(["Washington Post", "El Tiempo", "Le Monde"]);
    expect(traditionalSources).toEqual(["Washington Post", "El Tiempo", "Le Monde"]);
  });

  // ── social classification ────────────────────────────────────────────────────

  it("classifies @-prefixed handles as social", () => {
    const { socialSources, traditionalSources } = classifySources(["@latamwatcher", "@nytimes"]);
    expect(socialSources).toEqual(["@latamwatcher", "@nytimes"]);
    expect(traditionalSources).toEqual([]);
  });

  it("classifies sources containing 'twitter' as social (case-insensitive)", () => {
    const { socialSources } = classifySources(["Twitter News", "TWITTER", "twitter.com/feed"]);
    expect(socialSources).toHaveLength(3);
  });

  it("classifies sources containing 'x.com' as social", () => {
    const { socialSources } = classifySources(["x.com/news", "X.com/breaks"]);
    expect(socialSources).toHaveLength(2);
  });

  it.each([
    "instagram",
    "youtube",
    "tiktok",
    "reddit",
    "facebook",
    "linkedin",
  ])("classifies sources containing '%s' as social", (platform) => {
    const { socialSources, traditionalSources } = classifySources([`${platform} channel`]);
    expect(socialSources).toHaveLength(1);
    expect(traditionalSources).toHaveLength(0);
  });

  // ── mixed input ──────────────────────────────────────────────────────────────

  it("splits a mixed list into both buckets correctly", () => {
    const input = ["Reuters", "@latamwatcher", "NYT", "Twitter News", "El Tiempo", "@bbc"];
    const { traditionalSources, socialSources } = classifySources(input);
    expect(traditionalSources).toEqual(["Reuters", "NYT", "El Tiempo"]);
    expect(socialSources).toEqual(["@latamwatcher", "Twitter News", "@bbc"]);
  });

  // ── normalization: trim ──────────────────────────────────────────────────────

  it("trims leading and trailing whitespace before classifying", () => {
    const { traditionalSources } = classifySources(["  Reuters  ", "\tNYT\t"]);
    expect(traditionalSources).toEqual(["Reuters", "NYT"]);
  });

  it("trims before checking @-prefix", () => {
    const { socialSources } = classifySources(["  @handle  "]);
    expect(socialSources).toEqual(["@handle"]);
  });

  // ── normalization: dedupe ────────────────────────────────────────────────────

  it("deduplicates exact duplicates within traditional", () => {
    const { traditionalSources } = classifySources(["Reuters", "Reuters", "Reuters"]);
    expect(traditionalSources).toEqual(["Reuters"]);
  });

  it("deduplicates case-insensitively, keeping first-occurrence casing", () => {
    const { traditionalSources } = classifySources(["Reuters", "reuters", "REUTERS"]);
    expect(traditionalSources).toEqual(["Reuters"]);
  });

  it("deduplicates social handles case-insensitively", () => {
    const { socialSources } = classifySources(["@Handle", "@handle", "@HANDLE"]);
    expect(socialSources).toEqual(["@Handle"]);
  });

  it("deduplicates across a mixed list preserving first-occurrence order", () => {
    const input = ["Reuters", "@foo", "nyt", "Reuters", "@FOO", "NYT"];
    const { traditionalSources, socialSources } = classifySources(input);
    expect(traditionalSources).toEqual(["Reuters", "nyt"]);
    expect(socialSources).toEqual(["@foo"]);
  });

  // ── stable output order ──────────────────────────────────────────────────────

  it("preserves first-occurrence order within each bucket", () => {
    const input = ["El País", "Semana", "Reuters", "NYT"];
    const { traditionalSources } = classifySources(input);
    expect(traditionalSources).toEqual(["El País", "Semana", "Reuters", "NYT"]);
  });
});
