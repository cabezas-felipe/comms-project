import { describe, expect, it } from "vitest";
import {
  CONTRACT_VERSION,
  dashboardPayloadSchema,
  dashboardClusterCapMetaSchema,
  dashboardRefreshFailsafeMetaSchema,
  refreshFailureSchema,
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

describe("dashboardClusterCapMetaSchema", () => {
  // The four count/id fields are the stable surface existing clients read.
  const legacyClusterCap = {
    dedupedCount: 20,
    clusterInputCount: 15,
    clusterDroppedCount: 5,
    clusterDroppedSourceIds: ["src-15", "src-16", "src-17", "src-18", "src-19"],
  };

  const droppedEntry = {
    sourceId: "pe",
    headline: "Peru election results announced",
    rank: 16,
    preClusterScore: 6.13,
    components: {
      topicFit: 1,
      keywordFit: 1,
      geoFit: 0,
      entityFit: 0,
      corroboration: 0,
      beatFit: 0.64,
      freshness: 0.92,
      electionGeoBoost: -0.75,
    },
    electionGeoClass: "crossCountryElection" as const,
    hardFail: true,
    geoReason: "explicit_conflict",
    geoCategory: "explicit_conflict",
    headlineFamilyKey: "announced election peru results",
  };

  it("back-compat: validates a legacy payload with only the four old fields", () => {
    const parsed = dashboardClusterCapMetaSchema.parse(legacyClusterCap);
    expect(parsed.clusterDropped).toBeUndefined();
    expect(parsed.clusterDroppedSourceIds).toHaveLength(5);
  });

  it("validates an enriched payload with clusterDropped + clusterInputCapEffective", () => {
    const parsed = dashboardClusterCapMetaSchema.parse({
      ...legacyClusterCap,
      clusterInputCapEffective: 15,
      clusterDropped: [droppedEntry],
    });
    expect(parsed.clusterDropped).toHaveLength(1);
    expect(parsed.clusterDropped?.[0].electionGeoClass).toBe("crossCountryElection");
  });

  it("accepts null component values and null nullable fields", () => {
    const parsed = dashboardClusterCapMetaSchema.parse({
      ...legacyClusterCap,
      clusterDropped: [
        {
          ...droppedEntry,
          sourceId: null,
          preClusterScore: null,
          electionGeoClass: null,
          hardFail: null,
          geoReason: null,
          geoCategory: null,
          headlineFamilyKey: null,
          components: {
            topicFit: null,
            keywordFit: null,
            geoFit: null,
            entityFit: null,
            corroboration: null,
            beatFit: null,
            freshness: null,
            electionGeoBoost: null,
          },
        },
      ],
    });
    expect(parsed.clusterDropped?.[0].sourceId).toBeNull();
    expect(parsed.clusterDropped?.[0].components.topicFit).toBeNull();
  });

  it("accepts each known electionGeoClass enum value (and null)", () => {
    for (const cls of [
      "configuredGeoElection",
      "crossCountryElection",
      "nonElection",
      null,
    ] as const) {
      const parsed = dashboardClusterCapMetaSchema.parse({
        ...legacyClusterCap,
        clusterDropped: [{ ...droppedEntry, electionGeoClass: cls }],
      });
      expect(parsed.clusterDropped?.[0].electionGeoClass).toBe(cls);
    }
  });

  it("rejects an unknown electionGeoClass value", () => {
    expect(() =>
      dashboardClusterCapMetaSchema.parse({
        ...legacyClusterCap,
        clusterDropped: [{ ...droppedEntry, electionGeoClass: "someOtherClass" }],
      })
    ).toThrow();
  });

  it("rejects a payload missing a required count field", () => {
    const { dedupedCount: _omit, ...missing } = legacyClusterCap;
    expect(() => dashboardClusterCapMetaSchema.parse(missing)).toThrow();
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

describe("refreshFailureSchema", () => {
  const validFailure = {
    reason: "clustering_failure",
    subtype: "parse" as const,
    attempts: 2,
    retryable: false,
  };

  it("accepts a minimal failure (no retry timing)", () => {
    const parsed = refreshFailureSchema.parse(validFailure);
    expect(parsed.subtype).toBe("parse");
    expect(parsed.retryAfterMs).toBeUndefined();
    expect(parsed.nextRetryAt).toBeUndefined();
  });

  it("accepts the optional additive retry-timing fields when present", () => {
    const parsed = refreshFailureSchema.parse({
      ...validFailure,
      subtype: "timeout",
      retryable: true,
      retryAfterMs: 1500,
      nextRetryAt: "2026-06-10T00:00:01.500Z",
    });
    expect(parsed.retryAfterMs).toBe(1500);
    expect(parsed.nextRetryAt).toBe("2026-06-10T00:00:01.500Z");
  });

  it("accepts each known subtype", () => {
    for (const subtype of ["parse", "timeout", "provider_request", "unknown"] as const) {
      expect(refreshFailureSchema.parse({ ...validFailure, subtype }).subtype).toBe(subtype);
    }
  });

  it("rejects an unknown subtype", () => {
    expect(() => refreshFailureSchema.parse({ ...validFailure, subtype: "explosion" })).toThrow();
  });

  it("rejects a non-integer / negative attempts count", () => {
    expect(() => refreshFailureSchema.parse({ ...validFailure, attempts: -1 })).toThrow();
    expect(() => refreshFailureSchema.parse({ ...validFailure, attempts: 1.5 })).toThrow();
  });
});

describe("dashboardRefreshFailsafeMetaSchema", () => {
  // "Legacy" here = a real `_meta` object that predates this contract: it carries
  // assorted diagnostic keys but none of the fail-safe fields. The fail-safe
  // fields are now always emitted, so a current `_meta` is the legacy diagnostics
  // PLUS the three new keys — passthrough keeps both valid (additive).
  const legacyMetaDiagnostics = {
    hasSnapshot: true,
    unchanged: false,
    clusteringFailureReason: null,
    clusteringAttempts: 0,
    watermark: "wm-1",
  };

  it("ok success: refreshStatus=ok, refreshFailure=null, carries legacy keys (back-compat)", () => {
    const parsed = dashboardRefreshFailsafeMetaSchema.parse({
      ...legacyMetaDiagnostics,
      refreshStatus: "ok",
      refreshFailure: null,
      usedPriorSnapshot: false,
    });
    expect(parsed.refreshStatus).toBe("ok");
    expect(parsed.refreshFailure).toBeNull();
    expect(parsed.usedPriorSnapshot).toBe(false);
    // Legacy diagnostic keys survive validation via passthrough.
    expect((parsed as Record<string, unknown>).watermark).toBe("wm-1");
  });

  it("failed + prior snapshot: enriched payload with full failure object", () => {
    const parsed = dashboardRefreshFailsafeMetaSchema.parse({
      ...legacyMetaDiagnostics,
      clusteringFailureReason: "error",
      refreshStatus: "failed",
      refreshFailure: {
        reason: "clustering_failure",
        subtype: "parse",
        attempts: 2,
        retryable: false,
      },
      usedPriorSnapshot: true,
    });
    expect(parsed.refreshStatus).toBe("failed");
    expect(parsed.refreshFailure?.subtype).toBe("parse");
    expect(parsed.usedPriorSnapshot).toBe(true);
  });

  it("rejects an invalid refreshStatus value", () => {
    expect(() =>
      dashboardRefreshFailsafeMetaSchema.parse({
        refreshStatus: "degraded",
        refreshFailure: null,
        usedPriorSnapshot: false,
      })
    ).toThrow();
  });

  it("rejects a failed status whose failure object has a bad subtype", () => {
    expect(() =>
      dashboardRefreshFailsafeMetaSchema.parse({
        refreshStatus: "failed",
        refreshFailure: { reason: "clustering_failure", subtype: "nope", attempts: 1, retryable: true },
        usedPriorSnapshot: true,
      })
    ).toThrow();
  });

  it("rejects when usedPriorSnapshot is missing", () => {
    expect(() =>
      dashboardRefreshFailsafeMetaSchema.parse({ refreshStatus: "ok", refreshFailure: null })
    ).toThrow();
  });
});
