import { FixtureScenario, Story } from "@/lib/story";

const defaultFeed: Story[] = [
  {
    id: "story-001",
    title: "Trade corridor narrative shifts after bilateral transport statement",
    summary:
      "Coverage converges on a softer tone after both governments signaled coordination, but framing differs on who conceded first.",
    geos: ["US", "CO"],
    topics: ["trade", "diplomacy"],
    updatedAt: "2026-04-21T12:15:00.000Z",
    confidence: 0.86,
    trustFlags: [],
    delta: {
      type: "new-angle",
      text: "New official framing emphasizes regional security over tariffs.",
    },
    sources: [
      {
        id: "src-001",
        outlet: "Reuters",
        title: "US and Colombia issue joint transport statement",
        url: "https://example.com/reuters-transport",
        publishedAt: "2026-04-21T11:54:00.000Z",
        sourceType: "news",
        geo: "US",
      },
      {
        id: "src-002",
        outlet: "El Tiempo",
        title: "Gobiernos anuncian coordinacion en corredores",
        url: "https://example.com/eltiempo-corredores",
        publishedAt: "2026-04-21T11:41:00.000Z",
        sourceType: "news",
        geo: "CO",
      },
    ],
  },
  {
    id: "story-002",
    title: "Visa policy rumor spikes on social but lacks primary confirmation",
    summary:
      "High-volume social chatter claims immediate visa changes, but no policy bulletin is linked and reputable outlets have not confirmed details.",
    geos: ["US", "CO"],
    topics: ["immigration"],
    updatedAt: "2026-04-21T11:20:00.000Z",
    confidence: 0.58,
    trustFlags: ["missing-major-source", "low-confidence-summary"],
    delta: {
      type: "new-source",
      text: "Three new social accounts amplified the same unverified claim.",
    },
    sources: [
      {
        id: "src-003",
        outlet: "X / @PolicyWatchLatAm",
        title: "Thread claiming visa policy goes live this week",
        url: "https://example.com/x-visa-rumor",
        publishedAt: "2026-04-21T11:05:00.000Z",
        sourceType: "social",
        geo: "US",
      },
    ],
  },
];

const sparseFeed: Story[] = [
  {
    id: "story-003",
    title: "Energy cooperation coverage remains limited but consistent",
    summary:
      "Only two sources mention the update, both aligned on timeline and scope.",
    geos: ["CO"],
    topics: ["energy"],
    updatedAt: "2026-04-21T10:00:00.000Z",
    confidence: 0.79,
    trustFlags: [],
    delta: {
      type: "no-change",
      text: "No material change detected in the last cycle.",
    },
    sources: [
      {
        id: "src-004",
        outlet: "Ministerio de Minas y Energia",
        title: "Comunicado sobre hoja de ruta energetica",
        url: "https://example.com/minenergia-hoja-ruta",
        publishedAt: "2026-04-21T09:43:00.000Z",
        sourceType: "official",
        geo: "CO",
      },
    ],
  },
];

const staleFeed: Story[] = [
  {
    id: "story-004",
    title: "Security cooperation storyline appears stale",
    summary:
      "No new corroborating sources in the last 5 hours. Existing sources continue to recirculate prior statements.",
    geos: ["US", "CO"],
    topics: ["security"],
    updatedAt: "2026-04-21T05:00:00.000Z",
    confidence: 0.64,
    trustFlags: ["timestamp-stale"],
    delta: {
      type: "no-change",
      text: "No fresh evidence in current scan window.",
    },
    sources: [
      {
        id: "src-005",
        outlet: "AP",
        title: "Officials discuss regional security coordination",
        url: "https://example.com/ap-security",
        publishedAt: "2026-04-21T04:51:00.000Z",
        sourceType: "news",
        geo: "US",
      },
    ],
  },
];

const scenarioMap: Record<FixtureScenario, Story[]> = {
  "default-feed": defaultFeed,
  "sparse-feed": sparseFeed,
  "stale-feed": staleFeed,
  "empty-feed": [],
};

export function getStoryFixtures(scenario: FixtureScenario): Story[] {
  return scenarioMap[scenario];
}
