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
