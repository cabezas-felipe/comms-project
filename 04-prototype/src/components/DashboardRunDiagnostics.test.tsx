import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DashboardRunDiagnostics } from "@/components/DashboardRunDiagnostics";

// C1: the debug panel must render the split/overflow/recluster rows and must NOT
// crash on missing/partial metadata (all blocks optional / null).

describe("DashboardRunDiagnostics — C1 split/overflow/recluster rows", () => {
  it("renders all three new rows with full metadata", () => {
    render(
      <DashboardRunDiagnostics
        clusteringFailed={false}
        clusteringFailureReason={null}
        clusteringAttempts={1}
        funnel={null}
        recall={null}
        selection={null}
        clusterSplit={{
          enabled: true, inputCount: 4, outputCount: 5, splitCount: 1,
          splitReasons: { low_token_overlap: 1, disjoint_claim_evidence: 0 },
          deferredCount: 1, deferReasons: { ambiguous_unnormalized_overlap: 1, ambiguous_overlap_conflict: 0 },
          bundledStoryCount: 1, reclusterCandidateIds: ["ms-d"],
        }}
        overflowCap={{
          overflowCapApplied: true, overflowInputCount: 6, overflowOutputCount: 5,
          overflowDroppedCount: 1, overflowDroppedMetaStoryIds: ["ms-drop"],
        }}
        reclusterExecution={{
          status: "completed", totalQueued: 1, attempted: 1, succeeded: 1, failed: 0, timedOut: 0,
          candidates: [{ metaStoryId: "ms-d", outcome: "split" }],
        }}
        reclusterQueueCount={1}
      />,
    );
    expect(screen.getByTestId("diag-cluster-split").textContent).toContain("splits=1");
    expect(screen.getByTestId("diag-cluster-split").textContent).toContain("deferred=1");
    expect(screen.getByTestId("diag-overflow-cap").textContent).toContain("applied");
    expect(screen.getByTestId("diag-overflow-cap").textContent).toContain("ms-drop");
    expect(screen.getByTestId("diag-recluster").textContent).toContain("status=completed");
    expect(screen.getByTestId("diag-recluster").textContent).toContain("ms-d:split");
  });

  it("does not crash and shows n/a when the C1 blocks are absent (older snapshot)", () => {
    render(
      <DashboardRunDiagnostics
        clusteringFailed={false}
        clusteringFailureReason={null}
        clusteringAttempts={null}
        funnel={null}
        recall={null}
        selection={null}
      />,
    );
    expect(screen.getByTestId("diag-cluster-split").textContent).toContain("n/a");
    expect(screen.getByTestId("diag-overflow-cap").textContent).toContain("n/a");
    expect(screen.getByTestId("diag-recluster").textContent).toContain("n/a");
  });

  it("renders the cluster_cap row with scored top drops (enriched shape)", () => {
    render(
      <DashboardRunDiagnostics
        clusteringFailed={false}
        clusteringFailureReason={null}
        clusteringAttempts={1}
        funnel={null}
        recall={null}
        selection={null}
        clusterCap={{
          dedupedCount: 20,
          clusterInputCount: 15,
          clusterDroppedCount: 5,
          clusterDroppedSourceIds: ["src-15", "src-16", "src-17", "src-18", "src-19"],
          clusterDropped: [
            { sourceId: "src-15", preClusterScore: 6.13, rank: 16, electionGeoClass: "crossCountryElection" },
            { sourceId: "src-16", preClusterScore: 5.91, rank: 17, electionGeoClass: "nonElection" },
            { sourceId: "src-17", preClusterScore: 5.44, rank: 18, electionGeoClass: "nonElection" },
            { sourceId: "src-18", preClusterScore: 5.1, rank: 19, electionGeoClass: "nonElection" },
          ],
          clusterInputCapEffective: 15,
        }}
      />,
    );
    const row = screen.getByTestId("diag-cluster-cap");
    expect(row.textContent).toContain("deduped=20 kept=15 cap=15 dropped=5");
    // Bounded to the first 3 scored drops, sourceId(score) form.
    expect(row.textContent).toContain("top=[src-15(6.13), src-16(5.91), src-17(5.44)]");
    expect(row.textContent).not.toContain("src-18");
  });

  it("falls back to the dropped-id list when clusterDropped is absent (legacy shape)", () => {
    render(
      <DashboardRunDiagnostics
        clusteringFailed={false}
        clusteringFailureReason={null}
        clusteringAttempts={1}
        funnel={null}
        recall={null}
        selection={null}
        clusterCap={{
          dedupedCount: 18,
          clusterInputCount: 15,
          clusterDroppedCount: 3,
          clusterDroppedSourceIds: ["src-15", "src-16", "src-17"],
          clusterDropped: [],
          clusterInputCapEffective: null,
        }}
      />,
    );
    const row = screen.getByTestId("diag-cluster-cap");
    // No effective cap → cap segment omitted; falls back to the id list.
    expect(row.textContent).toContain("deduped=18 kept=15 dropped=3");
    expect(row.textContent).not.toContain("cap=");
    expect(row.textContent).toContain("ids=[src-15, src-16, src-17]");
    expect(row.textContent).not.toContain("top=");
  });

  it("shows n/a for cluster_cap when absent (older snapshot)", () => {
    render(
      <DashboardRunDiagnostics
        clusteringFailed={false}
        clusteringFailureReason={null}
        clusteringAttempts={null}
        funnel={null}
        recall={null}
        selection={null}
      />,
    );
    expect(screen.getByTestId("diag-cluster-cap").textContent).toContain("n/a");
  });

  it("shows the queued count when execution hasn't run yet (B1 queue, no B2 outcome)", () => {
    render(
      <DashboardRunDiagnostics
        clusteringFailed={false}
        clusteringFailureReason={null}
        clusteringAttempts={null}
        funnel={null}
        recall={null}
        selection={null}
        clusterSplit={null}
        overflowCap={{ overflowCapApplied: false, overflowInputCount: 3, overflowOutputCount: 3, overflowDroppedCount: 0, overflowDroppedMetaStoryIds: [] }}
        reclusterExecution={null}
        reclusterQueueCount={2}
      />,
    );
    expect(screen.getByTestId("diag-recluster").textContent).toContain("pending queued=2");
    expect(screen.getByTestId("diag-overflow-cap").textContent).toContain("not_applied");
  });
});

describe("DashboardRunDiagnostics — Phase 4 · Step 3 refresh fail-safe row (diag-refr)", () => {
  const base = {
    clusteringFailed: false,
    clusteringFailureReason: null,
    clusteringAttempts: null,
    funnel: null,
    recall: null,
    selection: null,
  } as const;

  // B6: deterministic-rescue (B3) + upgrade (B5) signals, default off.
  const detDefaults = {
    usedDeterministicClustering: false,
    clusteringLlmFailed: false,
    deterministicClusteringDiagnostics: null,
    upgradeRefreshScheduled: false,
    upgradeRefreshReason: null,
  } as const;

  it("renders status=failed with reason/subtype/attempts/retryable + usedPriorSnapshot", () => {
    render(
      <DashboardRunDiagnostics
        {...base}
        refreshFailsafe={{
          refreshStatus: "failed",
          usedPriorSnapshot: true,
          refreshFailure: { reason: "clustering_failure", subtype: "parse", attempts: 2, retryable: false, retryAfterMs: null, nextRetryAt: null },
          ...detDefaults,
        }}
      />,
    );
    const row = screen.getByTestId("diag-refr");
    expect(row.textContent).toContain("status=failed");
    expect(row.textContent).toContain("reason=clustering_failure");
    expect(row.textContent).toContain("subtype=parse");
    expect(row.textContent).toContain("attempts=2");
    expect(row.textContent).toContain("retryable=false");
    expect(row.textContent).toContain("usedPriorSnapshot=true");
  });

  it("renders status=ok (no failure detail) when refresh succeeded", () => {
    render(
      <DashboardRunDiagnostics
        {...base}
        refreshFailsafe={{ refreshStatus: "ok", usedPriorSnapshot: false, refreshFailure: null, ...detDefaults }}
      />,
    );
    const row = screen.getByTestId("diag-refr");
    expect(row.textContent).toContain("status=ok");
    expect(row.textContent).toContain("usedPriorSnapshot=false");
    expect(row.textContent).not.toContain("subtype=");
  });

  it("B6: renders status=degraded with deterministic + upgrade detail", () => {
    render(
      <DashboardRunDiagnostics
        {...base}
        refreshFailsafe={{
          refreshStatus: "degraded",
          usedPriorSnapshot: false,
          refreshFailure: { reason: "clustering_failure", subtype: "parse", attempts: 2, retryable: false, retryAfterMs: null, nextRetryAt: null },
          usedDeterministicClustering: true,
          clusteringLlmFailed: true,
          deterministicClusteringDiagnostics: { inputCount: 6, eligibleCount: 3, outputCount: 3, excludedReasons: { no_keyword_fit: 2 } },
          upgradeRefreshScheduled: true,
          upgradeRefreshReason: "degraded_deterministic_rescue",
        }}
      />,
    );
    const row = screen.getByTestId("diag-refr");
    expect(row.textContent).toContain("status=degraded");
    expect(row.textContent).toContain("llmFailed=true");
    expect(row.textContent).toContain("deterministic=true");
    expect(row.textContent).toContain("det_diag=in:6/elig:3/out:3");
    expect(row.textContent).toContain("upgrade=scheduled(degraded_deterministic_rescue)");
  });

  it("shows n/a when refreshFailsafe is absent (older payload)", () => {
    render(<DashboardRunDiagnostics {...base} />);
    expect(screen.getByTestId("diag-refr").textContent).toContain("n/a");
  });
});
