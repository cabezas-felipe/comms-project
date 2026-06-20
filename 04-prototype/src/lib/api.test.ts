import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONTRACT_VERSION } from "@tempo/contracts";
import {
  bootstrapDashboard,
  DashboardFetchError,
  fetchDashboardPayload,
  fetchDashboardWithMeta,
  fetchRefreshStatus,
  refreshDashboard,
} from "@/lib/api";
import { STORIES } from "@/data/stories";

vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: null } }),
    },
  },
}));

vi.mock("@/lib/auth", () => ({
  getProtoSession: vi.fn().mockReturnValue(null),
}));

describe("fetchDashboardPayload", () => {
  it("returns a contract-validated dashboard payload from HTTP response", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        contractVersion: CONTRACT_VERSION,
        stories: STORIES,
      }),
    });
    const payload = await fetchDashboardPayload({ fetcher });
    expect(payload.contractVersion).toBe(CONTRACT_VERSION);
    expect(payload.stories.length).toBeGreaterThan(0);
  });

  it("retries then throws DashboardFetchError (no fake-story fallback)", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("network down"));
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(
      fetchDashboardPayload({ fetcher, retries: 2, sleep })
    ).rejects.toBeInstanceOf(DashboardFetchError);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 200);
    expect(sleep).toHaveBeenNthCalledWith(2, 400);
  });

  it("does not return STORIES fallback after retry exhaustion (regression guard)", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("network down"));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const result = await fetchDashboardPayload({ fetcher, retries: 1, sleep })
      .then((p) => ({ ok: true as const, payload: p }))
      .catch((e) => ({ ok: false as const, error: e }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(DashboardFetchError);
    }
    // Belt-and-suspenders: ensure the fake-story payload is never produced.
    expect(STORIES.length).toBeGreaterThan(0); // sanity — STORIES is real demo data
    // (No way to "compare against STORIES" because the function throws.)
  });

  it("throws immediately when retries is 0 and the fetch fails", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("network down"));
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(
      fetchDashboardPayload({ fetcher, retries: 0, sleep })
    ).rejects.toBeInstanceOf(DashboardFetchError);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("throws DashboardFetchError(kind=http) when server returns HTTP error", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
    });
    const sleep = vi.fn().mockResolvedValue(undefined);
    let caught: unknown;
    try {
      await fetchDashboardPayload({ fetcher, retries: 1, sleep });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DashboardFetchError);
    expect((caught as DashboardFetchError).kind).toBe("http");
    expect((caught as DashboardFetchError).status).toBe(503);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("backs off between HTTP non-2xx retries (parity with network failure path)", async () => {
    // Regression guard: HTTP non-2xx used to skip the sleep() between attempts
    // because the if/else branch on `!response.ok` exited the try block before
    // reaching the catch where backoff lives. All retryable failure modes
    // (http, network, contract) must share the same sleep schedule.
    const fetcher = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    });
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(
      fetchDashboardPayload({ fetcher, retries: 2, sleep })
    ).rejects.toBeInstanceOf(DashboardFetchError);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 200);
    expect(sleep).toHaveBeenNthCalledWith(2, 400);
  });

  it("backs off between contract-validation retries", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ contractVersion: "wrong-version", stories: [] }),
    });
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(
      fetchDashboardPayload({ fetcher, retries: 2, sleep })
    ).rejects.toBeInstanceOf(DashboardFetchError);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 200);
    expect(sleep).toHaveBeenNthCalledWith(2, 400);
  });

  it("throws DashboardFetchError when response fails contract validation", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ contractVersion: "wrong-version", stories: [] }),
    });
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(
      fetchDashboardPayload({ fetcher, retries: 1, sleep })
    ).rejects.toBeInstanceOf(DashboardFetchError);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("Phase 2: fetchDashboardWithMeta surfaces _meta.selection from API response", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        contractVersion: CONTRACT_VERSION,
        stories: STORIES,
        _meta: {
          refreshedAt: "2026-05-08T00:00:00Z",
          hasSnapshot: true,
          selection: {
            sourceSelectionMode: "fallback",
            sourceFallbackUsed: true,
            sourceFallbackReason: "no_selected_sources",
            matchedSourceCount: 0,
            selectedSourceCount: 0,
            unmatchedSelectedSources: [],
            unavailableConnectorCount: 0,
            relevantItemCount: 0,
          },
        },
      }),
    });
    const { payload, selection } = await fetchDashboardWithMeta({ fetcher });
    expect(payload.contractVersion).toBe(CONTRACT_VERSION);
    expect(selection).not.toBeNull();
    expect(selection?.sourceSelectionMode).toBe("fallback");
    expect(selection?.sourceFallbackUsed).toBe(true);
    expect(selection?.sourceFallbackReason).toBe("no_selected_sources");
  });

  it("Phase 2: fetchDashboardWithMeta returns selection=null when API omits _meta.selection", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ contractVersion: CONTRACT_VERSION, stories: STORIES }),
    });
    const { selection } = await fetchDashboardWithMeta({ fetcher });
    expect(selection).toBeNull();
  });

  it("Phase 4: fetchDashboardWithMeta tolerates new optional _meta fields (unchanged/watermark/refreshSkippedReason)", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        contractVersion: CONTRACT_VERSION,
        stories: STORIES,
        _meta: {
          refreshedAt: "2026-05-08T00:00:00Z",
          hasSnapshot: true,
          unchanged: true,
          refreshSkippedReason: "unchanged_watermark",
          watermark: "wm-abc",
          candidateCount: 5,
          selectedFeedCount: 2,
        },
      }),
    });
    const { payload, selection } = await fetchDashboardWithMeta({ fetcher });
    expect(payload.contractVersion).toBe(CONTRACT_VERSION);
    // No selection field provided here — parser must not throw and just returns null
    expect(selection).toBeNull();
  });

  it("Phase 4: fetchDashboardWithMeta tolerates refreshSkippedReason=in_flight without selection meta", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        contractVersion: CONTRACT_VERSION,
        stories: STORIES,
        _meta: {
          hasSnapshot: true,
          refreshSkippedReason: "in_flight",
          unchanged: false,
        },
      }),
    });
    const { payload } = await fetchDashboardWithMeta({ fetcher });
    expect(payload.contractVersion).toBe(CONTRACT_VERSION);
  });

  it("Phase 2: fetchDashboardWithMeta tolerates malformed _meta.selection (returns null without throwing)", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        contractVersion: CONTRACT_VERSION,
        stories: STORIES,
        _meta: { selection: { sourceSelectionMode: "not-a-valid-mode" } },
      }),
    });
    const { selection } = await fetchDashboardWithMeta({ fetcher });
    expect(selection).toBeNull();
  });

  it("fetchDashboardWithMeta surfaces _meta.refreshedAt when present and valid", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        contractVersion: CONTRACT_VERSION,
        stories: STORIES,
        _meta: { refreshedAt: "2026-05-08T00:00:00Z" },
      }),
    });
    const { refreshedAt } = await fetchDashboardWithMeta({ fetcher });
    expect(refreshedAt).toBe("2026-05-08T00:00:00Z");
  });

  it("fetchDashboardWithMeta returns refreshedAt=null when _meta.refreshedAt is missing", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ contractVersion: CONTRACT_VERSION, stories: STORIES }),
    });
    const { refreshedAt } = await fetchDashboardWithMeta({ fetcher });
    expect(refreshedAt).toBeNull();
  });

  it("fetchDashboardWithMeta returns refreshedAt=null when _meta.refreshedAt is not a valid date string", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        contractVersion: CONTRACT_VERSION,
        stories: STORIES,
        _meta: { refreshedAt: "not-a-date" },
      }),
    });
    const { refreshedAt } = await fetchDashboardWithMeta({ fetcher });
    expect(refreshedAt).toBeNull();
  });

  it("fetchDashboardWithMeta returns refreshedAt=null when _meta.refreshedAt is the wrong type", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        contractVersion: CONTRACT_VERSION,
        stories: STORIES,
        _meta: { refreshedAt: 1715126400000 },
      }),
    });
    const { refreshedAt } = await fetchDashboardWithMeta({ fetcher });
    expect(refreshedAt).toBeNull();
  });

  it("fetchDashboardWithMeta surfaces _meta.lastCheckedAt when present and valid", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        contractVersion: CONTRACT_VERSION,
        stories: STORIES,
        _meta: {
          refreshedAt: "2026-05-08T00:00:00Z",
          lastCheckedAt: "2026-05-08T01:00:00Z",
        },
      }),
    });
    const { refreshedAt, lastCheckedAt } = await fetchDashboardWithMeta({ fetcher });
    expect(refreshedAt).toBe("2026-05-08T00:00:00Z");
    expect(lastCheckedAt).toBe("2026-05-08T01:00:00Z");
  });

  it("fetchDashboardWithMeta returns lastCheckedAt=null when omitted (older API)", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        contractVersion: CONTRACT_VERSION,
        stories: STORIES,
        _meta: { refreshedAt: "2026-05-08T00:00:00Z" },
      }),
    });
    const { lastCheckedAt } = await fetchDashboardWithMeta({ fetcher });
    expect(lastCheckedAt).toBeNull();
  });

  it("fetchDashboardWithMeta returns lastCheckedAt=null for unparseable date string", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        contractVersion: CONTRACT_VERSION,
        stories: STORIES,
        _meta: { lastCheckedAt: "not-a-date" },
      }),
    });
    const { lastCheckedAt } = await fetchDashboardWithMeta({ fetcher });
    expect(lastCheckedAt).toBeNull();
  });

  it("rethrows AbortError immediately without retrying or sleeping", async () => {
    const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });
    const fetcher = vi.fn().mockRejectedValue(abortError);
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(
      fetchDashboardPayload({ fetcher, retries: 2, sleep })
    ).rejects.toThrow("aborted");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("Slice 3: funnel + recall diagnostics from _meta", () => {
  it("lifts funnel + recall when present", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        contractVersion: CONTRACT_VERSION,
        stories: [],
        _meta: {
          funnel: {
            totalNormalized: 33,
            afterGeoFilter: 18,
            finalStories: 2,
            primaryDropStage: "geo_filter",
            executionMode: "full_run",
          },
          recall: {
            mode: "hybrid_strict",
            keywordRecallCount: 12,
            finalRelevant: 8,
            similarityRejected: 3,
            minSimilarityThreshold: 0.4,
          },
        },
      }),
    });
    const result = await fetchDashboardWithMeta({ fetcher });
    expect(result.funnel?.totalNormalized).toBe(33);
    expect(result.funnel?.finalStories).toBe(2);
    expect(result.funnel?.primaryDropStage).toBe("geo_filter");
    expect(result.recall?.keywordRecallCount).toBe(12);
    expect(result.recall?.similarityRejected).toBe(3);
    expect(result.recall?.minSimilarityThreshold).toBe(0.4);
  });

  it("returns funnel=null / recall=null when absent", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ contractVersion: CONTRACT_VERSION, stories: [], _meta: {} }),
    });
    const result = await fetchDashboardWithMeta({ fetcher });
    expect(result.funnel).toBeNull();
    expect(result.recall).toBeNull();
  });

  it("degrades malformed funnel/recall fields to null without throwing", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        contractVersion: CONTRACT_VERSION,
        stories: [],
        _meta: {
          funnel: { totalNormalized: "lots", primaryDropStage: 42 },
          recall: { similarityRejected: "three", minSimilarityThreshold: null },
        },
      }),
    });
    const result = await fetchDashboardWithMeta({ fetcher });
    expect(result.funnel?.totalNormalized).toBeNull();
    expect(result.funnel?.primaryDropStage).toBeNull();
    expect(result.recall?.similarityRejected).toBeNull();
    expect(result.recall?.minSimilarityThreshold).toBeNull();
  });
});

describe("C1: split / overflow / re-cluster diagnostics from _meta", () => {
  it("lifts clusterSplit + overflowCap + reclusterExecution + reclusterQueueCount when present", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        contractVersion: CONTRACT_VERSION,
        stories: [],
        _meta: {
          clusterSplit: {
            enabled: true, inputCount: 4, outputCount: 5, splitCount: 1,
            splitReasons: { low_token_overlap: 1, disjoint_claim_evidence: 0 },
            deferredCount: 1, deferReasons: { ambiguous_unnormalized_overlap: 1, ambiguous_overlap_conflict: 0 },
            bundledStoryCount: 1, reclusterCandidateIds: ["ms-d"],
          },
          overflowCap: {
            overflowCapApplied: true, overflowInputCount: 6, overflowOutputCount: 5,
            overflowDroppedCount: 1, overflowDroppedMetaStoryIds: ["ms-drop"],
          },
          reclusterExecution: {
            status: "completed", totalQueued: 1, attempted: 1, succeeded: 1, failed: 0, timedOut: 0,
            candidates: [{ metaStoryId: "ms-d", outcome: "split" }],
          },
          reclusterQueueCount: 1,
          clusterCap: {
            dedupedCount: 20, clusterInputCount: 15, clusterDroppedCount: 5,
            clusterDroppedSourceIds: ["src-15", "src-16", "src-17", "src-18", "src-19"],
            clusterInputCapEffective: 15,
            clusterDropped: [
              { sourceId: "src-15", headline: "h", rank: 16, preClusterScore: 6.13, components: {}, electionGeoClass: "crossCountryElection", hardFail: true, geoReason: "explicit_conflict", geoCategory: "explicit_conflict", headlineFamilyKey: "k" },
            ],
          },
        },
      }),
    });
    const result = await fetchDashboardWithMeta({ fetcher });
    expect(result.clusterSplit?.splitCount).toBe(1);
    expect(result.clusterSplit?.deferredCount).toBe(1);
    expect(result.clusterSplit?.splitReasons.low_token_overlap).toBe(1);
    expect(result.clusterSplit?.reclusterCandidateIds).toEqual(["ms-d"]);
    expect(result.overflowCap?.overflowCapApplied).toBe(true);
    expect(result.overflowCap?.overflowDroppedMetaStoryIds).toEqual(["ms-drop"]);
    expect(result.reclusterExecution?.status).toBe("completed");
    expect(result.reclusterExecution?.succeeded).toBe(1);
    expect(result.reclusterExecution?.candidates[0]).toEqual({ metaStoryId: "ms-d", outcome: "split" });
    expect(result.reclusterQueueCount).toBe(1);
    // Phase 1: cluster-input cap diagnostics (counts + enriched per-drop subset).
    expect(result.clusterCap?.dedupedCount).toBe(20);
    expect(result.clusterCap?.clusterInputCapEffective).toBe(15);
    expect(result.clusterCap?.clusterDroppedSourceIds).toHaveLength(5);
    expect(result.clusterCap?.clusterDropped[0]).toEqual({
      sourceId: "src-15", preClusterScore: 6.13, rank: 16, electionGeoClass: "crossCountryElection",
    });
  });

  it("returns null blocks when absent (backward compat)", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ contractVersion: CONTRACT_VERSION, stories: [], _meta: {} }),
    });
    const result = await fetchDashboardWithMeta({ fetcher });
    expect(result.clusterSplit).toBeNull();
    expect(result.overflowCap).toBeNull();
    expect(result.reclusterExecution).toBeNull();
    expect(result.reclusterQueueCount).toBeNull();
    expect(result.clusterCap).toBeNull();
  });

  it("parses a legacy clusterCap (counts + ids only, no clusterDropped/cap)", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        contractVersion: CONTRACT_VERSION,
        stories: [],
        _meta: {
          clusterCap: {
            dedupedCount: 18, clusterInputCount: 15, clusterDroppedCount: 3,
            clusterDroppedSourceIds: ["src-15", "src-16", "src-17"],
          },
        },
      }),
    });
    const result = await fetchDashboardWithMeta({ fetcher });
    expect(result.clusterCap?.clusterDropped).toEqual([]); // absent → empty
    expect(result.clusterCap?.clusterInputCapEffective).toBeNull();
    expect(result.clusterCap?.clusterDroppedSourceIds).toEqual(["src-15", "src-16", "src-17"]);
  });

  it("parses cleanly with no _meta at all (no throw)", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ contractVersion: CONTRACT_VERSION, stories: [] }),
    });
    const result = await fetchDashboardWithMeta({ fetcher });
    expect(result.clusterSplit).toBeNull();
    expect(result.overflowCap).toBeNull();
    expect(result.reclusterExecution).toBeNull();
  });

  it("degrades malformed C1 fields without throwing", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        contractVersion: CONTRACT_VERSION,
        stories: [],
        _meta: {
          clusterSplit: { splitCount: "many", splitReasons: "nope", reclusterCandidateIds: [1, "ok", null] },
          overflowCap: { overflowCapApplied: "yes", overflowDroppedMetaStoryIds: "x" },
          reclusterExecution: { status: 7, candidates: "none" },
          reclusterQueueCount: "two",
        },
      }),
    });
    const result = await fetchDashboardWithMeta({ fetcher });
    // Block is non-null (object present) but fields degrade safely.
    expect(result.clusterSplit?.splitCount).toBeNull();
    expect(result.clusterSplit?.splitReasons).toEqual({});
    expect(result.clusterSplit?.reclusterCandidateIds).toEqual(["ok"]); // non-strings dropped
    expect(result.overflowCap?.overflowCapApplied).toBe(false); // non-true → false
    expect(result.overflowCap?.overflowDroppedMetaStoryIds).toEqual([]);
    expect(result.reclusterExecution?.status).toBeNull();
    expect(result.reclusterExecution?.candidates).toEqual([]);
    expect(result.reclusterQueueCount).toBeNull();
  });
});

describe("Slice 2: clustering fail-closed diagnostics from _meta", () => {
  it("happy path — no clustering keys → clusteringFailed=false, nulls elsewhere", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        contractVersion: CONTRACT_VERSION,
        stories: STORIES,
        _meta: { refreshedAt: "2026-05-08T00:00:00Z", hasSnapshot: true },
      }),
    });
    const result = await fetchDashboardWithMeta({ fetcher });
    expect(result.clusteringFailed).toBe(false);
    expect(result.clusteringFailureReason).toBeNull();
    expect(result.clusteringAttempts).toBeNull();
    expect(result.clusteringLatencyMs).toBeNull();
  });

  it("fail-closed path — usedFallbackClustering=true + reason=timeout surfaces clusteringFailed", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        contractVersion: CONTRACT_VERSION,
        stories: [],
        _meta: {
          refreshedAt: "2026-05-08T00:00:00Z",
          hasSnapshot: true,
          usedFallbackClustering: true,
          clusteringFailureReason: "timeout",
          clusteringAttempts: 2,
          clusteringLatencyMs: [25000, 25001],
        },
      }),
    });
    const result = await fetchDashboardWithMeta({ fetcher });
    expect(result.payload.stories).toHaveLength(0);
    expect(result.clusteringFailed).toBe(true);
    expect(result.clusteringFailureReason).toBe("timeout");
    expect(result.clusteringAttempts).toBe(2);
    expect(result.clusteringLatencyMs).toEqual([25000, 25001]);
  });

  it("error reason is surfaced and propagates through refreshDashboard", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        contractVersion: CONTRACT_VERSION,
        stories: [],
        _meta: {
          usedFallbackClustering: true,
          clusteringFailureReason: "error",
          clusteringAttempts: 2,
        },
      }),
    });
    const result = await refreshDashboard({ fetcher });
    expect(result.clusteringFailed).toBe(true);
    expect(result.clusteringFailureReason).toBe("error");
    expect(result.clusteringLatencyMs).toBeNull();
  });

  it("malformed _meta clustering fields degrade safely (never reads as failed)", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        contractVersion: CONTRACT_VERSION,
        stories: STORIES,
        _meta: {
          usedFallbackClustering: "yes", // not boolean true
          clusteringFailureReason: "weird", // not timeout|error
          clusteringAttempts: "two", // not a number
          clusteringLatencyMs: [null, "x"], // not all numbers
        },
      }),
    });
    const result = await fetchDashboardWithMeta({ fetcher });
    expect(result.clusteringFailed).toBe(false);
    expect(result.clusteringFailureReason).toBeNull();
    expect(result.clusteringAttempts).toBeNull();
    expect(result.clusteringLatencyMs).toBeNull();
  });

  it("bootstrapDashboard also surfaces clustering diagnostics", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        contractVersion: CONTRACT_VERSION,
        stories: [],
        _meta: {
          bootstrapDecision: "ran_refresh",
          usedFallbackClustering: true,
          clusteringFailureReason: "timeout",
          clusteringAttempts: 2,
        },
      }),
    });
    const result = await bootstrapDashboard({ fetcher });
    expect(result.decision).toBe("ran_refresh");
    expect(result.clusteringFailed).toBe(true);
    expect(result.clusteringFailureReason).toBe("timeout");
  });
});

describe("Phase 4 · Step 3: refresh fail-safe meta from _meta", () => {
  function metaFetcher(meta: Record<string, unknown> | undefined, stories = STORIES) {
    return vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ contractVersion: CONTRACT_VERSION, stories, ...(meta ? { _meta: meta } : {}) }),
    });
  }

  it("parses an enriched failure with prior snapshot (failed + full failure object)", async () => {
    const result = await fetchDashboardWithMeta({
      fetcher: metaFetcher({
        refreshStatus: "failed",
        usedPriorSnapshot: true,
        refreshFailure: {
          reason: "clustering_failure",
          subtype: "parse",
          attempts: 2,
          retryable: false,
          retryAfterMs: 1500,
          nextRetryAt: "2026-06-10T00:00:01.500Z",
        },
      }),
    });
    expect(result.refreshStatus).toBe("failed");
    expect(result.usedPriorSnapshot).toBe(true);
    expect(result.refreshFailure).toEqual({
      reason: "clustering_failure",
      subtype: "parse",
      attempts: 2,
      retryable: false,
      retryAfterMs: 1500,
      nextRetryAt: "2026-06-10T00:00:01.500Z",
    });
  });

  it("parses a failure with no prior snapshot and omitted retry timing", async () => {
    const result = await fetchDashboardWithMeta({
      fetcher: metaFetcher({
        refreshStatus: "failed",
        usedPriorSnapshot: false,
        refreshFailure: { reason: "clustering_failure", subtype: "timeout", attempts: 2, retryable: true },
      }, []),
    });
    expect(result.refreshStatus).toBe("failed");
    expect(result.usedPriorSnapshot).toBe(false);
    expect(result.refreshFailure?.subtype).toBe("timeout");
    expect(result.refreshFailure?.retryAfterMs).toBeNull();
    expect(result.refreshFailure?.nextRetryAt).toBeNull();
  });

  it("ok status surfaces refreshFailure=null", async () => {
    const result = await fetchDashboardWithMeta({
      fetcher: metaFetcher({ refreshStatus: "ok", usedPriorSnapshot: false }),
    });
    expect(result.refreshStatus).toBe("ok");
    expect(result.refreshFailure).toBeNull();
    expect(result.usedPriorSnapshot).toBe(false);
  });

  it("legacy payload WITHOUT fail-safe fields defaults to ok / null / false (back-compat)", async () => {
    const result = await fetchDashboardWithMeta({
      fetcher: metaFetcher({ refreshedAt: "2026-06-10T00:00:00Z", hasSnapshot: true }),
    });
    expect(result.refreshStatus).toBe("ok");
    expect(result.refreshFailure).toBeNull();
    expect(result.usedPriorSnapshot).toBe(false);
  });

  it("payload with no _meta at all defaults safely (never throws, never failed)", async () => {
    const result = await fetchDashboardWithMeta({ fetcher: metaFetcher(undefined) });
    expect(result.refreshStatus).toBe("ok");
    expect(result.refreshFailure).toBeNull();
  });

  it("malformed fail-safe fields degrade safely (unknown subtype, non-bool retryable)", async () => {
    const result = await fetchDashboardWithMeta({
      fetcher: metaFetcher({
        refreshStatus: "failed",
        usedPriorSnapshot: "yes", // not boolean true → false
        refreshFailure: { reason: 42, subtype: "explosion", attempts: "two", retryable: "maybe" },
      }),
    });
    expect(result.refreshStatus).toBe("failed");
    expect(result.usedPriorSnapshot).toBe(false);
    expect(result.refreshFailure?.reason).toBeNull(); // non-string → null
    expect(result.refreshFailure?.subtype).toBe("unknown"); // unrecognized → unknown
    expect(result.refreshFailure?.attempts).toBeNull();
    expect(result.refreshFailure?.retryable).toBeNull();
  });

  it("an UNKNOWN refreshStatus string is treated as ok (no false failure)", async () => {
    const result = await fetchDashboardWithMeta({
      fetcher: metaFetcher({ refreshStatus: "weird", refreshFailure: { subtype: "parse" } }),
    });
    expect(result.refreshStatus).toBe("ok");
    expect(result.refreshFailure).toBeNull();
  });

  // ── B6: degraded deterministic rescue + B3/B5 additive fields ──────────────

  it("parses refreshStatus=degraded with the retained failure metadata + B3/B5 fields", async () => {
    const result = await fetchDashboardWithMeta({
      fetcher: metaFetcher({
        refreshStatus: "degraded",
        usedPriorSnapshot: false,
        refreshFailure: { reason: "clustering_failure", subtype: "parse", attempts: 2, retryable: false },
        clusteringLlmFailed: true,
        usedDeterministicClustering: true,
        deterministicClusteringDiagnostics: {
          inputCount: 6,
          eligibleCount: 3,
          outputCount: 3,
          excludedReasons: { no_keyword_fit: 2, over_cap: 1 },
        },
        upgradeRefreshScheduled: true,
        upgradeRefreshReason: "degraded_deterministic_rescue",
      }),
    });
    expect(result.refreshStatus).toBe("degraded");
    // Degraded retains the LLM-failure metadata for attribution.
    expect(result.refreshFailure?.subtype).toBe("parse");
    expect(result.clusteringLlmFailed).toBe(true);
    expect(result.usedDeterministicClustering).toBe(true);
    expect(result.deterministicClusteringDiagnostics).toEqual({
      inputCount: 6,
      eligibleCount: 3,
      outputCount: 3,
      excludedReasons: { no_keyword_fit: 2, over_cap: 1 },
    });
    expect(result.upgradeRefreshScheduled).toBe(true);
    expect(result.upgradeRefreshReason).toBe("degraded_deterministic_rescue");
  });

  it("legacy/ok payloads omit the B3/B5 fields → safe defaults (false / null), never degraded", async () => {
    const result = await fetchDashboardWithMeta({
      fetcher: metaFetcher({ refreshStatus: "ok", usedPriorSnapshot: false }),
    });
    expect(result.refreshStatus).toBe("ok");
    expect(result.usedDeterministicClustering).toBe(false);
    expect(result.clusteringLlmFailed).toBe(false);
    expect(result.deterministicClusteringDiagnostics).toBeNull();
    expect(result.upgradeRefreshScheduled).toBe(false);
    expect(result.upgradeRefreshReason).toBeNull();
  });

  it("malformed deterministicClusteringDiagnostics degrades safely (null counts, {} reasons)", async () => {
    const result = await fetchDashboardWithMeta({
      fetcher: metaFetcher({
        refreshStatus: "degraded",
        refreshFailure: { reason: "clustering_failure", subtype: "parse", attempts: 1, retryable: false },
        deterministicClusteringDiagnostics: {
          inputCount: "lots", // non-number → null
          excludedReasons: { ok: 2, bad: "nope" }, // non-number value dropped
        },
        usedDeterministicClustering: "yes", // non-bool → false
      }),
    });
    expect(result.refreshStatus).toBe("degraded");
    expect(result.usedDeterministicClustering).toBe(false);
    expect(result.deterministicClusteringDiagnostics).toEqual({
      inputCount: null,
      eligibleCount: null,
      outputCount: null,
      excludedReasons: { ok: 2 },
    });
  });

  // Step 4 integration sanity: a real server emits the fail-safe fields ALONGSIDE
  // the legacy clustering diagnostics in one `_meta`. The parser must surface both
  // coherently — this guards against the new fields shadowing/breaking the old
  // ones, and confirms the exact shape Dashboard.applyResult consumes.
  it("surfaces fail-safe AND legacy clustering fields from one server-style _meta (coexistence)", async () => {
    const result = await fetchDashboardWithMeta({
      fetcher: metaFetcher({
        // legacy clustering surface (server keeps emitting these)
        usedFallbackClustering: true,
        clusteringFailureReason: "timeout",
        clusteringFailureSubtype: "timeout_budget",
        clusteringAttempts: 2,
        // new fail-safe surface (Step 2 contract)
        refreshStatus: "failed",
        usedPriorSnapshot: true,
        refreshFailure: { reason: "clustering_failure", subtype: "timeout", attempts: 2, retryable: true },
      }, []),
    });
    // Legacy fields still parse.
    expect(result.clusteringFailed).toBe(true);
    expect(result.clusteringFailureReason).toBe("timeout");
    expect(result.clusteringAttempts).toBe(2);
    // New fail-safe fields parse and agree with the legacy surface.
    expect(result.refreshStatus).toBe("failed");
    expect(result.usedPriorSnapshot).toBe(true);
    expect(result.refreshFailure).toEqual({
      reason: "clustering_failure",
      subtype: "timeout",
      attempts: 2,
      retryable: true,
      retryAfterMs: null,
      nextRetryAt: null,
    });
    // The exact keys Dashboard.applyResult reads are all present.
    expect(result).toHaveProperty("refreshStatus");
    expect(result).toHaveProperty("refreshFailure");
    expect(result).toHaveProperty("usedPriorSnapshot");
  });
});

describe("fetchDashboardPayload — identity header propagation", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("DEFAULT mode: Bearer wins over recognized-email when both exist (production-safe)", async () => {
    // No VITE_E2E_IDENTITY_PRECEDENCE override → a valid Bearer session beats the
    // prototype recognized-email header. This is the High-finding fix.
    const { supabase } = await import("@/lib/supabase");
    const { getProtoSession } = await import("@/lib/auth");
    vi.spyOn(supabase.auth, "getSession").mockResolvedValue({
      data: { session: { access_token: "test-bearer-token", user: { id: "u1" } } },
    } as unknown as Awaited<ReturnType<typeof supabase.auth.getSession>>);
    vi.mocked(getProtoSession).mockReturnValue({ email: "user@example.com", userId: "u1" });

    let capturedHeaders: Record<string, string> = {};
    const fetcher = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedHeaders = { ...(init.headers as Record<string, string>) };
      return { ok: true, status: 200, json: async () => ({ contractVersion: CONTRACT_VERSION, stories: STORIES }) } as Response;
    });

    await fetchDashboardPayload({ fetcher, retries: 0 }).catch(() => undefined);

    expect(capturedHeaders["Authorization"]).toBe("Bearer test-bearer-token");
    expect(capturedHeaders["x-recognized-email"]).toBeUndefined();
  });

  it("E2E override mode: prefers x-recognized-email over Bearer when both exist", async () => {
    vi.stubEnv("VITE_E2E_IDENTITY_PRECEDENCE", "recognized_email");
    const { supabase } = await import("@/lib/supabase");
    const { getProtoSession } = await import("@/lib/auth");
    vi.spyOn(supabase.auth, "getSession").mockResolvedValue({
      data: { session: { access_token: "test-bearer-token", user: { id: "u1" } } },
    } as unknown as Awaited<ReturnType<typeof supabase.auth.getSession>>);
    vi.mocked(getProtoSession).mockReturnValue({ email: "user@example.com", userId: "u1" });

    let capturedHeaders: Record<string, string> = {};
    const fetcher = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedHeaders = { ...(init.headers as Record<string, string>) };
      return { ok: true, status: 200, json: async () => ({ contractVersion: CONTRACT_VERSION, stories: STORIES }) } as Response;
    });

    await fetchDashboardPayload({ fetcher, retries: 0 }).catch(() => undefined);

    expect(capturedHeaders["x-recognized-email"]).toBe("user@example.com");
    expect(capturedHeaders["Authorization"]).toBeUndefined();
  });

  it("sends x-recognized-email when no bearer but proto session exists", async () => {
    const { supabase } = await import("@/lib/supabase");
    const { getProtoSession } = await import("@/lib/auth");
    vi.spyOn(supabase.auth, "getSession").mockResolvedValue({
      data: { session: null },
    } as unknown as Awaited<ReturnType<typeof supabase.auth.getSession>>);
    vi.mocked(getProtoSession).mockReturnValue({ email: "user@example.com", userId: "u1" });

    let capturedHeaders: Record<string, string> = {};
    const fetcher = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedHeaders = { ...(init.headers as Record<string, string>) };
      return { ok: false, status: 503, json: async () => ({}) } as Response;
    });

    await fetchDashboardPayload({ fetcher, retries: 0 }).catch(() => undefined);

    expect(capturedHeaders["x-recognized-email"]).toBe("user@example.com");
    expect(capturedHeaders["Authorization"]).toBeUndefined();
  });

  it("sends no identity headers when neither bearer nor proto session is present", async () => {
    const { supabase } = await import("@/lib/supabase");
    const { getProtoSession } = await import("@/lib/auth");
    vi.spyOn(supabase.auth, "getSession").mockResolvedValue({
      data: { session: null },
    } as unknown as Awaited<ReturnType<typeof supabase.auth.getSession>>);
    vi.mocked(getProtoSession).mockReturnValue(null);

    let capturedHeaders: Record<string, string> = {};
    const fetcher = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedHeaders = { ...(init.headers as Record<string, string>) };
      return { ok: false, status: 401, json: async () => ({}) } as Response;
    });

    await fetchDashboardPayload({ fetcher, retries: 0 }).catch(() => undefined);

    expect(capturedHeaders["Authorization"]).toBeUndefined();
    expect(capturedHeaders["x-recognized-email"]).toBeUndefined();
  });
});

describe("Phase 5: bootstrapDashboard", () => {
  it("POSTs to /api/dashboard/bootstrap and surfaces decision=served_fresh_snapshot", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    const fetcher = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedMethod = init.method ?? "";
      return {
        ok: true,
        status: 200,
        json: async () => ({
          contractVersion: CONTRACT_VERSION,
          stories: STORIES,
          _meta: {
            hasSnapshot: true,
            refreshedAt: "2026-05-08T00:00:00Z",
            bootstrapDecision: "served_fresh_snapshot",
          },
        }),
      };
    });
    const { payload, decision } = await bootstrapDashboard({ fetcher, retries: 0 });
    expect(capturedUrl).toBe("/api/dashboard/bootstrap");
    expect(capturedMethod).toBe("POST");
    expect(payload.contractVersion).toBe(CONTRACT_VERSION);
    expect(decision).toBe("served_fresh_snapshot");
  });

  it("parses decision=ran_refresh", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        contractVersion: CONTRACT_VERSION,
        stories: STORIES,
        _meta: { hasSnapshot: true, bootstrapDecision: "ran_refresh" },
      }),
    });
    const { decision } = await bootstrapDashboard({ fetcher, retries: 0 });
    expect(decision).toBe("ran_refresh");
  });

  it("parses decision=no_snapshot", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        contractVersion: CONTRACT_VERSION,
        stories: STORIES,
        _meta: { hasSnapshot: false, bootstrapDecision: "no_snapshot" },
      }),
    });
    const { decision } = await bootstrapDashboard({ fetcher, retries: 0 });
    expect(decision).toBe("no_snapshot");
  });

  it("returns decision=null when API omits the field (forward compat)", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ contractVersion: CONTRACT_VERSION, stories: STORIES }),
    });
    const { decision } = await bootstrapDashboard({ fetcher, retries: 0 });
    expect(decision).toBeNull();
  });

  it("returns decision=null when API supplies an unknown enum value (defensive)", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        contractVersion: CONTRACT_VERSION,
        stories: STORIES,
        _meta: { bootstrapDecision: "rebooted_the_universe" },
      }),
    });
    const { decision } = await bootstrapDashboard({ fetcher, retries: 0 });
    expect(decision).toBeNull();
  });

  it("throws DashboardFetchError on non-2xx after retries exhausted (no STORIES fallback)", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
    });
    const sleep = vi.fn().mockResolvedValue(undefined);
    let caught: unknown;
    try {
      await bootstrapDashboard({ fetcher, retries: 1, sleep });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DashboardFetchError);
    expect((caught as DashboardFetchError).kind).toBe("http");
    expect((caught as DashboardFetchError).status).toBe(503);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("bootstrapDashboard surfaces _meta.refreshedAt when present and valid", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        contractVersion: CONTRACT_VERSION,
        stories: STORIES,
        _meta: {
          hasSnapshot: true,
          refreshedAt: "2026-05-08T12:34:56Z",
          bootstrapDecision: "served_fresh_snapshot",
        },
      }),
    });
    const { refreshedAt } = await bootstrapDashboard({ fetcher, retries: 0 });
    expect(refreshedAt).toBe("2026-05-08T12:34:56Z");
  });

  it("bootstrapDashboard returns refreshedAt=null when _meta.refreshedAt is missing", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        contractVersion: CONTRACT_VERSION,
        stories: STORIES,
        _meta: { hasSnapshot: true, bootstrapDecision: "ran_refresh" },
      }),
    });
    const { refreshedAt } = await bootstrapDashboard({ fetcher, retries: 0 });
    expect(refreshedAt).toBeNull();
  });

  it("bootstrapDashboard returns refreshedAt=null when _meta.refreshedAt is invalid", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        contractVersion: CONTRACT_VERSION,
        stories: STORIES,
        _meta: { hasSnapshot: true, refreshedAt: "definitely not a date" },
      }),
    });
    const { refreshedAt } = await bootstrapDashboard({ fetcher, retries: 0 });
    expect(refreshedAt).toBeNull();
  });

  it("backs off between HTTP non-2xx retries (bootstrap parity)", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({}),
    });
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(
      bootstrapDashboard({ fetcher, retries: 2, sleep })
    ).rejects.toBeInstanceOf(DashboardFetchError);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 200);
    expect(sleep).toHaveBeenNthCalledWith(2, 400);
  });
});

describe("refreshDashboard", () => {
  it("POSTs to /api/dashboard/refresh by default and returns { payload, selection, refreshedAt }", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    const fetcher = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedMethod = init.method ?? "";
      return {
        ok: true,
        status: 200,
        json: async () => ({
          contractVersion: CONTRACT_VERSION,
          stories: STORIES,
          _meta: {
            refreshedAt: "2026-05-08T12:34:56Z",
            selection: {
              sourceSelectionMode: "strict",
              sourceFallbackUsed: false,
              matchedSourceCount: 2,
              selectedSourceCount: 2,
              unmatchedSelectedSources: [],
              unavailableConnectorCount: 0,
              relevantItemCount: 4,
            },
          },
        }),
      };
    });
    const { payload, selection, refreshedAt } = await refreshDashboard({ fetcher, retries: 0 });
    expect(capturedUrl).toBe("/api/dashboard/refresh");
    expect(capturedMethod).toBe("POST");
    expect(payload.contractVersion).toBe(CONTRACT_VERSION);
    expect(refreshedAt).toBe("2026-05-08T12:34:56Z");
    expect(selection?.sourceSelectionMode).toBe("strict");
    expect(selection?.matchedSourceCount).toBe(2);
  });

  it("Prompt 4: retains expanded selection fields (social, per-kind counts, blockedSocialSources)", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        contractVersion: CONTRACT_VERSION,
        stories: STORIES,
        _meta: {
          selection: {
            sourceSelectionMode: "strict",
            sourceFallbackUsed: false,
            // Combined headline counts (Prompt 3).
            matchedSourceCount: 2,
            selectedSourceCount: 3,
            unmatchedSelectedSources: ["Made-Up Outlet"],
            unavailableConnectorCount: 0,
            // Social diagnostics (Prompts 2–3).
            socialSelectionApplied: true,
            matchedSocialSourceCount: 1,
            matchedSocialSources: ["@petrogustavo"],
            // Per-kind breakdown (Prompt 3).
            matchedTraditionalSourceCount: 1,
            selectedTraditionalSourceCount: 2,
            selectedSocialSourceCount: 1,
            // Allowlist diagnostics (Prompt 4).
            blockedSocialSources: ["@blockedhandle"],
          },
        },
      }),
    });
    const { selection } = await refreshDashboard({ fetcher, retries: 0 });
    expect(selection).not.toBeNull();
    // The defensive parser must PRESERVE the new optional fields, not strip them.
    expect(selection?.socialSelectionApplied).toBe(true);
    expect(selection?.matchedSocialSourceCount).toBe(1);
    expect(selection?.matchedSocialSources).toEqual(["@petrogustavo"]);
    expect(selection?.matchedTraditionalSourceCount).toBe(1);
    expect(selection?.selectedTraditionalSourceCount).toBe(2);
    expect(selection?.selectedSocialSourceCount).toBe(1);
    expect(selection?.blockedSocialSources).toEqual(["@blockedhandle"]);
  });

  it("returns refreshedAt=null when _meta.refreshedAt is missing", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ contractVersion: CONTRACT_VERSION, stories: STORIES }),
    });
    const { refreshedAt } = await refreshDashboard({ fetcher, retries: 0 });
    expect(refreshedAt).toBeNull();
  });

  it("returns refreshedAt=null when _meta.refreshedAt is not a parseable date string", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        contractVersion: CONTRACT_VERSION,
        stories: STORIES,
        _meta: { refreshedAt: "definitely not a date" },
      }),
    });
    const { refreshedAt } = await refreshDashboard({ fetcher, retries: 0 });
    expect(refreshedAt).toBeNull();
  });

  it("returns refreshedAt=null when _meta.refreshedAt is the wrong type", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        contractVersion: CONTRACT_VERSION,
        stories: STORIES,
        _meta: { refreshedAt: 1715126400000 },
      }),
    });
    const { refreshedAt } = await refreshDashboard({ fetcher, retries: 0 });
    expect(refreshedAt).toBeNull();
  });

  it("returns selection=null when _meta.selection is malformed (defensive parse)", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        contractVersion: CONTRACT_VERSION,
        stories: STORIES,
        _meta: { selection: { sourceSelectionMode: "not-a-valid-mode" } },
      }),
    });
    const { selection } = await refreshDashboard({ fetcher, retries: 0 });
    expect(selection).toBeNull();
  });

  it("throws DashboardFetchError(kind=http) on non-2xx after retries exhausted", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
    });
    const sleep = vi.fn().mockResolvedValue(undefined);
    let caught: unknown;
    try {
      await refreshDashboard({ fetcher, retries: 1, sleep });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DashboardFetchError);
    expect((caught as DashboardFetchError).kind).toBe("http");
    expect((caught as DashboardFetchError).status).toBe(503);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("throws DashboardFetchError(kind=network) on network failures and respects retries", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("network down"));
    const sleep = vi.fn().mockResolvedValue(undefined);
    let caught: unknown;
    try {
      await refreshDashboard({ fetcher, retries: 2, sleep });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DashboardFetchError);
    expect((caught as DashboardFetchError).kind).toBe("network");
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 200);
    expect(sleep).toHaveBeenNthCalledWith(2, 400);
  });

  it("backs off between HTTP non-2xx retries (parity with other helpers)", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({}),
    });
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(
      refreshDashboard({ fetcher, retries: 2, sleep })
    ).rejects.toBeInstanceOf(DashboardFetchError);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 200);
    expect(sleep).toHaveBeenNthCalledWith(2, 400);
  });

  it("throws DashboardFetchError(kind=contract) when response fails contract validation", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ contractVersion: "wrong-version", stories: [] }),
    });
    const sleep = vi.fn().mockResolvedValue(undefined);
    let caught: unknown;
    try {
      await refreshDashboard({ fetcher, retries: 1, sleep });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DashboardFetchError);
    expect((caught as DashboardFetchError).kind).toBe("contract");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rethrows AbortError immediately without retrying or sleeping", async () => {
    const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });
    const fetcher = vi.fn().mockRejectedValue(abortError);
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(
      refreshDashboard({ fetcher, retries: 2, sleep })
    ).rejects.toThrow("aborted");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("fetchRefreshStatus", () => {
  it("parses a valid running response into the minimal contract", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        jobId: "user-1",
        status: "running",
        phase: "clustering",
        storyCount: null,
        failureReason: null,
      }),
    });
    const result = await fetchRefreshStatus("user-1", { fetcher });
    expect(result).toEqual({
      jobId: "user-1",
      status: "running",
      phase: "clustering",
      storyCount: null,
      failureReason: null,
    });
    // The job id is path-encoded onto the status endpoint.
    expect(fetcher).toHaveBeenCalledWith(
      "/api/dashboard/refresh-status/user-1",
      expect.objectContaining({ method: "GET" })
    );
  });

  it("parses a done response carrying a storyCount", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        jobId: "user-1",
        status: "done",
        phase: "done",
        storyCount: 4,
        failureReason: null,
      }),
    });
    const result = await fetchRefreshStatus("user-1", { fetcher });
    expect(result.status).toBe("done");
    expect(result.storyCount).toBe(4);
  });

  it("parses a failed response carrying a failureReason", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        jobId: "user-1",
        status: "failed",
        phase: "done",
        storyCount: null,
        failureReason: "clustering_timeout",
      }),
    });
    const result = await fetchRefreshStatus("user-1", { fetcher });
    expect(result.status).toBe("failed");
    expect(result.failureReason).toBe("clustering_timeout");
  });

  it("degrades absent/mistyped phase & storyCount to null without throwing", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ jobId: "user-1", status: "running" }),
    });
    const result = await fetchRefreshStatus("user-1", { fetcher });
    expect(result.phase).toBeNull();
    expect(result.storyCount).toBeNull();
    expect(result.failureReason).toBeNull();
  });

  it("throws DashboardFetchError(contract) when status is outside the known enum", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ jobId: "user-1", status: "bogus_state" }),
    });
    await expect(fetchRefreshStatus("user-1", { fetcher })).rejects.toMatchObject({
      name: "DashboardFetchError",
      kind: "contract",
    });
  });

  it("throws DashboardFetchError(contract) when jobId is missing", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: "running" }),
    });
    await expect(fetchRefreshStatus("user-1", { fetcher })).rejects.toMatchObject({
      kind: "contract",
    });
  });

  it("throws DashboardFetchError(http) with status on a non-2xx response", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ code: "FORBIDDEN_REFRESH_JOB" }),
    });
    await expect(fetchRefreshStatus("user-1", { fetcher })).rejects.toMatchObject({
      name: "DashboardFetchError",
      kind: "http",
      status: 403,
    });
  });

  it("throws DashboardFetchError(network) when the fetch itself rejects", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("offline"));
    await expect(fetchRefreshStatus("user-1", { fetcher })).rejects.toMatchObject({
      kind: "network",
    });
  });
});
