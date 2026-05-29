import type {
  DashboardFunnelMeta,
  DashboardRecallMeta,
} from "@/lib/api";
import type { DashboardSelectionMeta } from "@tempo/contracts";

/**
 * Dev / manual-E2E diagnostics panel (Slice 3).
 *
 * Renders the latest dashboard fetch's `_meta` diagnostics — clustering block,
 * funnel summary, recall summary, selection summary — so a manual golden
 * re-test can see WHY the dashboard is empty or thin without reading server
 * logs. Gated by the caller (debug mode only); never shown in normal use, and
 * carries no end-user copy.
 */
export interface DashboardRunDiagnosticsProps {
  clusteringFailed: boolean;
  clusteringFailureReason: "timeout" | "error" | null;
  clusteringAttempts: number | null;
  funnel: DashboardFunnelMeta | null;
  recall: DashboardRecallMeta | null;
  selection: DashboardSelectionMeta | null;
}

const NA = "n/a";

function num(v: number | null | undefined): string {
  return typeof v === "number" ? String(v) : NA;
}

function funnelLine(funnel: DashboardFunnelMeta | null): string {
  if (!funnel) return NA;
  const stages = [
    funnel.totalNormalized,
    funnel.afterTimeWindow,
    funnel.afterSourceSelection,
    funnel.afterGeoFilter,
    funnel.afterTopicKeyword,
    funnel.afterBeatFit,
    funnel.afterDedupe,
    funnel.finalStories,
  ]
    .map((n) => (n === null || n === undefined ? NA : String(n)))
    .join(" → ");
  const drop = funnel.primaryDropStage ?? NA;
  return `${stages}  (primary_drop=${drop})`;
}

function recallLine(recall: DashboardRecallMeta | null): string {
  if (!recall) return NA;
  const floor =
    typeof recall.minSimilarityThreshold === "number"
      ? recall.minSimilarityThreshold.toFixed(2)
      : NA;
  return `keyword=${num(recall.keywordRecallCount)} final=${num(recall.finalRelevant)} semantic_rejected=${num(recall.similarityRejected)} floor=${floor} mode=${recall.mode ?? NA}`;
}

function selectionLine(selection: DashboardSelectionMeta | null): string {
  if (!selection) return NA;
  const matched = num(selection.matchedSourceCount);
  const selected = num(selection.selectedSourceCount);
  const unavailable = selection.unavailableConnectorSources ?? [];
  const unavailableStr = unavailable.length > 0 ? `[${unavailable.join(", ")}]` : "[]";
  const feeds = selection.matchedFeedIds ?? [];
  const feedsStr = feeds.length > 0 ? `[${feeds.join(", ")}]` : "[]";
  return `matched=${matched}/${selected} unavailable=${unavailableStr} feeds=${feedsStr}`;
}

function Row({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="flex gap-2" data-testid={testId}>
      <span className="shrink-0 font-semibold text-foreground/80">{label}</span>
      <span className="break-all text-muted-foreground">{value}</span>
    </div>
  );
}

export function DashboardRunDiagnostics({
  clusteringFailed,
  clusteringFailureReason,
  clusteringAttempts,
  funnel,
  recall,
  selection,
}: DashboardRunDiagnosticsProps) {
  const clusteringValue = clusteringFailed
    ? `failed reason=${clusteringFailureReason ?? NA} attempts=${num(clusteringAttempts)}`
    : `ok attempts=${num(clusteringAttempts)}`;

  return (
    <div
      data-testid="dashboard-run-diagnostics"
      className="mx-6 my-4 rounded-sm border border-dashed border-rule/70 bg-muted/30 px-4 py-3 font-mono text-[11px] leading-relaxed"
    >
      <div className="mb-1.5 font-semibold uppercase tracking-wider text-muted-foreground">
        run diagnostics · debug
      </div>
      <Row label="clustering:" value={clusteringValue} testId="diag-clustering" />
      <Row label="funnel:" value={funnelLine(funnel)} testId="diag-funnel" />
      <Row label="recall:" value={recallLine(recall)} testId="diag-recall" />
      <Row label="selection:" value={selectionLine(selection)} testId="diag-selection" />
    </div>
  );
}
