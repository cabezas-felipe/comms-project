import type {
  DashboardFunnelMeta,
  DashboardRecallMeta,
  DashboardClusterSplitMeta,
  DashboardOverflowCapMeta,
  DashboardClusterCapMeta,
  DashboardReclusterExecutionMeta,
  DashboardRefreshFailsafeMeta,
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
  // C1 — split-healer (A3) / overflow cap (A4) / deferred re-cluster (B1 queue +
  // B2 execution). Optional so older callers compile unchanged; absent → "n/a".
  clusterSplit?: DashboardClusterSplitMeta | null;
  overflowCap?: DashboardOverflowCapMeta | null;
  // Phase 1: cluster-INPUT cap (pre-clustering relevance cap). Optional/additive
  // so older callers compile unchanged; absent → "n/a".
  clusterCap?: DashboardClusterCapMeta | null;
  reclusterExecution?: DashboardReclusterExecutionMeta | null;
  reclusterQueueCount?: number | null;
  // Phase 4 · Step 3: refresh fail-safe status (refreshStatus / refreshFailure /
  // usedPriorSnapshot). Optional/additive so older callers compile unchanged;
  // absent → "n/a".
  refreshFailsafe?: DashboardRefreshFailsafeMeta | null;
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

function reasonsStr(reasons: Record<string, number>): string {
  const active = Object.entries(reasons).filter(([, v]) => v > 0).map(([k, v]) => `${k}=${v}`);
  return active.length > 0 ? active.join(",") : "none";
}

// C1: split-healer (A3) summary — input/output counts, split count + reasons,
// bundling, and the deferred (re-cluster candidate) tally with its reasons.
function splitLine(c: DashboardClusterSplitMeta | null): string {
  if (!c) return NA;
  const cands = c.reclusterCandidateIds.length > 0 ? `[${c.reclusterCandidateIds.join(", ")}]` : "[]";
  return `in=${num(c.inputCount)} out=${num(c.outputCount)} splits=${num(c.splitCount)} (${reasonsStr(c.splitReasons)}) bundled=${num(c.bundledStoryCount)} deferred=${num(c.deferredCount)} (${reasonsStr(c.deferReasons)}) candidates=${cands}`;
}

// C1: overflow cap (A4) summary — whether the max-5 cap trimmed stories + ids.
function overflowLine(o: DashboardOverflowCapMeta | null): string {
  if (!o) return NA;
  if (!o.overflowCapApplied) return `not_applied (in=${num(o.overflowInputCount)} out=${num(o.overflowOutputCount)})`;
  const dropped = o.overflowDroppedMetaStoryIds.length > 0 ? `[${o.overflowDroppedMetaStoryIds.join(", ")}]` : "[]";
  return `applied in=${num(o.overflowInputCount)} out=${num(o.overflowOutputCount)} dropped=${num(o.overflowDroppedCount)} ${dropped}`;
}

// Phase 1: cluster-INPUT cap summary — deduped candidate count, kept count + the
// effective cap, dropped count, and a BOUNDED top-3 of dropped candidates.
// Prefers the enriched scored drops (`src(score)`); falls back to the legacy
// dropped-id list when no enriched entries are present.
function clusterCapLine(c: DashboardClusterCapMeta | null): string {
  if (!c) return NA;
  const cap =
    typeof c.clusterInputCapEffective === "number" ? ` cap=${c.clusterInputCapEffective}` : "";
  const head = `deduped=${num(c.dedupedCount)} kept=${num(c.clusterInputCount)}${cap} dropped=${num(c.clusterDroppedCount)}`;
  if (c.clusterDropped.length > 0) {
    const top = c.clusterDropped.slice(0, 3).map((e) => {
      const id = e.sourceId ?? "?";
      return typeof e.preClusterScore === "number" ? `${id}(${e.preClusterScore.toFixed(2)})` : id;
    });
    return `${head} top=[${top.join(", ")}]`;
  }
  if (c.clusterDroppedSourceIds.length > 0) {
    return `${head} ids=[${c.clusterDroppedSourceIds.slice(0, 3).join(", ")}]`;
  }
  return head;
}

// C1: deferred re-cluster (B2 execution; falls back to the B1 queued count when
// the deferred pass hasn't run yet — e.g. on the immediate refresh response).
function reclusterLine(
  exec: DashboardReclusterExecutionMeta | null,
  queuedCount: number | null,
): string {
  if (!exec) {
    return typeof queuedCount === "number" && queuedCount > 0 ? `pending queued=${queuedCount}` : NA;
  }
  const cands =
    exec.candidates.length > 0
      ? exec.candidates.map((c) => `${c.metaStoryId ?? "?"}:${c.outcome ?? "?"}`).join(", ")
      : "none";
  return `status=${exec.status ?? NA} queued=${num(exec.totalQueued)} attempted=${num(exec.attempted)} ok=${num(exec.succeeded)} fail=${num(exec.failed)} timeout=${num(exec.timedOut)} [${cands}]`;
}

// Phase 4 · Step 3: refresh fail-safe summary — status, and when failed the
// failure reason/subtype/attempts/retryable, plus the usedPriorSnapshot flag.
function refreshLine(r: DashboardRefreshFailsafeMeta | null | undefined): string {
  if (!r) return NA;
  const prior = `usedPriorSnapshot=${r.usedPriorSnapshot}`;
  if (r.refreshStatus !== "failed" || !r.refreshFailure) {
    return `status=ok ${prior}`;
  }
  const f = r.refreshFailure;
  const retryable = typeof f.retryable === "boolean" ? String(f.retryable) : NA;
  return `status=failed reason=${f.reason ?? NA} subtype=${f.subtype} attempts=${num(f.attempts)} retryable=${retryable} ${prior}`;
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
  clusterSplit = null,
  overflowCap = null,
  clusterCap = null,
  reclusterExecution = null,
  reclusterQueueCount = null,
  refreshFailsafe = null,
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
      <Row label="refresh:" value={refreshLine(refreshFailsafe)} testId="diag-refr" />
      <Row label="clustering:" value={clusteringValue} testId="diag-clustering" />
      <Row label="funnel:" value={funnelLine(funnel)} testId="diag-funnel" />
      <Row label="recall:" value={recallLine(recall)} testId="diag-recall" />
      <Row label="selection:" value={selectionLine(selection)} testId="diag-selection" />
      <Row label="cluster_cap:" value={clusterCapLine(clusterCap)} testId="diag-cluster-cap" />
      <Row label="split/defer:" value={splitLine(clusterSplit)} testId="diag-cluster-split" />
      <Row label="overflow_cap:" value={overflowLine(overflowCap)} testId="diag-overflow-cap" />
      <Row label="recluster:" value={reclusterLine(reclusterExecution, reclusterQueueCount)} testId="diag-recluster" />
    </div>
  );
}
