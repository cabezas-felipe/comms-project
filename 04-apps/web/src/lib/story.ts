export type Geo = "US" | "CO";

export type SourceType = "news" | "social" | "official";

export type DeltaType = "new-source" | "new-angle" | "new-actor" | "no-change";

export type StoryTrustFlag =
  | "missing-major-source"
  | "timestamp-stale"
  | "low-confidence-summary";

export interface StorySource {
  id: string;
  outlet: string;
  title: string;
  url: string;
  publishedAt: string;
  sourceType: SourceType;
  geo: Geo;
}

export interface StoryDelta {
  type: DeltaType;
  text: string;
}

export interface Story {
  id: string;
  title: string;
  summary: string;
  geos: Geo[];
  topics: string[];
  updatedAt: string;
  confidence: number;
  trustFlags: StoryTrustFlag[];
  delta: StoryDelta;
  sources: StorySource[];
}

export type FixtureScenario =
  | "default-feed"
  | "sparse-feed"
  | "stale-feed"
  | "empty-feed";
