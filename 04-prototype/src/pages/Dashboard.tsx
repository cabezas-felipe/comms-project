import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import { Source, Story } from "@/data/stories";
import { deriveSignals } from "@/lib/derive";
import StoryCard from "@/components/StoryCard";
import SourceReader from "@/components/SourceReader";
import { ClusteringFailedState, EmptyState, ErrorState, LoadingState, RefreshDegradedBanner, RefreshFailedBanner, RefreshFailedState } from "@/components/StateBlocks";
import {
  trackDashboardViewed,
  trackSourceOpenError,
  trackSourceOpened,
  trackStoryExpanded,
} from "@/lib/analytics";
import {
  bootstrapDashboard,
  DashboardFetchError,
  fetchDashboardWithMeta,
  fetchRefreshStatus,
  recoverDashboardViaGet,
  refreshDashboard,
  type DashboardBootstrapDecision,
  type DashboardBootstrapResult,
  type DashboardFetchResult,
  type DashboardFunnelMeta,
  type DashboardRecallMeta,
  type DashboardWhyEnrichmentMeta,
  type DashboardClusterSplitMeta,
  type DashboardOverflowCapMeta,
  type DashboardClusterCapMeta,
  type DashboardReclusterExecutionMeta,
  type DashboardRefreshFailsafeMeta,
} from "@/lib/api";
import { DashboardRunDiagnostics } from "@/components/DashboardRunDiagnostics";
import { formatKeywordLabel } from "@/lib/format";
import {
  aggregateTagSections,
  isEmptySelection,
  storyMatchesSelection,
  toggleInSet,
  type TagSelection,
  type TagSections,
} from "@/lib/dashboard-filters";
import { type StoryDto, type DashboardSelectionMeta } from "@tempo/contracts";
import { fetchSettingsPayload } from "@/lib/settings-api";
import { notifyError, notifyWarning } from "@/lib/notify";
import { isUxTestMode } from "@/lib/ux-test-mode";
import { useRefreshContext } from "@/lib/refresh-context";
import { REFRESH_INTERVAL_MS } from "@/lib/refresh-heartbeat";

/**
 * Whether the refresh clock should advance after a bootstrap call settles.
 *
 * The bootstrap route reports its decision in `_meta.bootstrapDecision`:
 *   - `served_fresh_snapshot` — the server returned the persisted snapshot
 *     WITHOUT running the refresh executor.  No refresh attempt actually
 *     happened, so the clock must stay where the last real attempt left it.
 *   - any other decision (`ran_refresh`, `no_snapshot`, or a null decision
 *     from an older API) — the server ran (or tried to run) the refresh
 *     executor.  Settling this counts as a refresh attempt that advances
 *     the clock per the standard "every attempt moves the badge" semantics.
 *
 * Failures advance unconditionally: the client did attempt a refresh, the
 * server just didn't return useful data.  Treating failure as no-op would
 * strand the countdown on a stale anchor across a network outage.
 */
export function shouldAdvanceClockForBootstrap(args: {
  failed: boolean;
  decision: DashboardBootstrapDecision | null;
}): boolean {
  if (args.failed) return true;
  return args.decision !== "served_fresh_snapshot";
}

// Slice 4: onboarding-driven interactive refresh requests the backend's
// balanced fast-path profile (bounded geo + clustering envelope → 20–30s first
// paint) via the `?interactive=1` query param.  Only the onboarding entry
// (forceRefresh) uses this endpoint; the heartbeat/scheduled refresh keeps the
// default `/api/dashboard/refresh` and therefore the default profile.
const INTERACTIVE_REFRESH_ENDPOINT = "/api/dashboard/refresh?interactive=1";

// Slice 10: every user-triggered retry runs the DEFAULT profile explicitly,
// regardless of how the dashboard was first entered (onboarding interactive,
// cold-start join, bootstrap, timeout, fail-closed, etc.). The server reads
// `?profile=default`.
const RETRY_DEFAULT_REFRESH_ENDPOINT = "/api/dashboard/refresh?profile=default";

// Slice 5: how often to poll GET /api/dashboard for upgraded whyItMatters while
// an interactive run's enrichment is pending, and the upper bound on how long
// to keep polling before giving up (the fallback copy already on screen stays).
const WHY_POLL_INTERVAL_MS = 3000;
const WHY_POLL_BUDGET_MS = 60000;

// Slice 9: cold-start JOIN polling — how often to poll the prefetch job status
// (Slice 7 endpoint) and the upper bound before falling back to the normal
// dashboard load path.
const JOIN_POLL_INTERVAL_MS = 2000;
const JOIN_MAX_MS = 60000;

// Minimal, operational phase copy shown while JOINed to an in-flight cold-start
// refresh. Unknown/absent phases fall back to a generic line.
const JOIN_PHASE_COPY: Record<string, string> = {
  ingesting: "Gathering sources…",
  matching: "Matching your beat…",
  clustering: "Assembling stories…",
};
const JOIN_PROGRESS_FALLBACK = "Preparing your first stories…";
// Shown when the join ends without a terminal job result (budget elapsed or a
// terminal 403/404 from the status endpoint) before falling back to the loader.
const JOIN_FALLBACK_WARNING = "Still preparing your first stories — loading what we have.";

function dtoToStory(dto: StoryDto): Story {
  return {
    id: dto.id,
    title: dto.title,
    geographies: dto.geographies,
    topic: dto.topic,
    subtitle: dto.subtitle,
    summary: dto.summary,
    whyItMatters: dto.whyItMatters,
    whatChanged: dto.whatChanged,
    priority: dto.priority,
    outletCount: dto.outletCount,
    sources: dto.sources.map((s) => ({
      id: s.id,
      outlet: s.outlet,
      byline: s.byline,
      kind: s.kind,
      weight: s.weight,
      url: s.url,
      minutesAgo: s.minutesAgo,
      headline: s.headline,
      body: s.body,
    })),
    tags: dto.tags
      ? {
          topics: [...dto.tags.topics],
          keywords: [...dto.tags.keywords],
          geographies: [...dto.tags.geographies],
        }
      : undefined,
  };
}

export default function Dashboard() {
  const {
    seedAnchorIfMissing,
    heartbeatResult,
    lastAttemptAt,
    isRefreshing,
    recordAttemptStart,
    recordAttemptFinished,
  } = useRefreshContext();
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const emptyMode = searchParams.get("empty") === "1";

  // Phase 5: bootstrap is reserved for two entry surfaces only — Landing →
  // Dashboard for recognized users, and Onboarding → Dashboard post-submit.
  // Both navigate with `state: { bootstrap: true }`.  Settings, in-app links,
  // browser back/forward, and direct URL loads do NOT carry this flag and use
  // the cheaper GET path.
  const navState = location.state as
    | { bootstrap?: boolean; forceRefresh?: boolean; coldStartJobId?: string }
    | null;
  const useBootstrap = navState?.bootstrap === true;
  // Slice 2: Onboarding → Dashboard passes `forceRefresh: true` so the loader
  // runs the POST refresh pipeline directly instead of letting bootstrap reuse
  // a stale "fresh" snapshot written before onboarding's settings landed.
  // `forceRefresh` takes precedence over `bootstrap` when both are present.
  const forceRefresh = navState?.forceRefresh === true;
  // Slice 9: Onboarding handoff may pass the cold-start prefetch job handle.
  // When present (non-empty string), the dashboard JOINs that in-flight refresh
  // by polling its status instead of immediately firing its own POST /refresh.
  const coldStartJobId =
    typeof navState?.coldStartJobId === "string" && navState.coldStartJobId.trim().length > 0
      ? navState.coldStartJobId.trim()
      : null;

  // Phase 6: dynamic, multi-select header pill state (one Set per section).
  // Empty sets across all three sections = "All" (no filters applied).
  const [selectedTopics, setSelectedTopics] = useState<ReadonlySet<string>>(() => new Set());
  const [selectedKeywords, setSelectedKeywords] = useState<ReadonlySet<string>>(() => new Set());
  const [selectedGeographies, setSelectedGeographies] = useState<ReadonlySet<string>>(() => new Set());
  // Phase 1.2: pill sections are settings-backed.  The saved settings
  // vocabulary (topics/keywords/geographies) is fetched once on load and the
  // visible pills are intersected against it below.  `null` means "not yet
  // fetched OR fetch failed" — the conservative state where NO pills are
  // introduced (an out-of-settings value can never leak into the pill row).
  const [settingsVocab, setSettingsVocab] = useState<TagSections | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [activeSourceId, setActiveSourceId] = useState<string | null>(null);
  // Stories are seeded empty — no static demo fallback. The dashboard renders
  // Loading/Empty/Error blocks until the backend supplies a payload.
  const [stories, setStories] = useState<Story[]>([]);
  const [isLoading, setIsLoading] = useState(!emptyMode);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(emptyMode);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Slice 2: clustering fail-closed signal lifted from `_meta`.  When true the
  // last successful refresh published zero stories because clustering failed —
  // distinct from a quiet beat, so the empty zone renders dedicated copy.
  const [clusteringFailed, setClusteringFailed] = useState(false);
  const [clusteringFailureReason, setClusteringFailureReason] = useState<
    "timeout" | "error" | null
  >(null);
  // Phase 4 · Step 3: refresh fail-safe status lifted from `_meta` (Step 2 server
  // contract). `refreshStatus="failed"` means the refresh itself failed (parse /
  // timeout / provider issue) — distinct from a quiet beat. When stories are
  // present alongside it (server preserved a prior snapshot) we keep rendering
  // them under a non-blocking warning banner; when empty we render a dedicated
  // failure-aware empty state instead of the quiet copy.
  const [refreshFailsafe, setRefreshFailsafe] =
    useState<DashboardRefreshFailsafeMeta | null>(null);
  // Slice 3: extra `_meta` diagnostics from the latest successful fetch, used
  // only by the debug panel (gated below). Captured alongside stories so the
  // panel reflects whatever last updated the feed.
  const [runDiagnostics, setRunDiagnostics] = useState<{
    clusteringAttempts: number | null;
    selection: DashboardSelectionMeta | null;
    funnel: DashboardFunnelMeta | null;
    recall: DashboardRecallMeta | null;
    // C1 — split/overflow/re-cluster diagnostics (debug panel only).
    clusterSplit: DashboardClusterSplitMeta | null;
    overflowCap: DashboardOverflowCapMeta | null;
    clusterCap: DashboardClusterCapMeta | null;
    reclusterExecution: DashboardReclusterExecutionMeta | null;
    reclusterQueueCount: number | null;
  } | null>(null);
  // Slice 5: progressive whyItMatters enrichment state from the latest fetch.
  // When `deferred && pending > 0`, the dashboard polls GET /api/dashboard and
  // patches story cards in place as upgraded copy lands.
  const [whyEnrichment, setWhyEnrichment] = useState<DashboardWhyEnrichmentMeta | null>(null);
  const [reloadCounter, setReloadCounter] = useState(0);

  // Slice 9: cold-start JOIN lifecycle.  `active` while polling the prefetch
  // job; `done`/`failed` are terminal job outcomes; `timeout` means the 60s
  // budget elapsed and we fall back to the normal loader.  `inactive` when no
  // job handle was handed off (existing behavior, unchanged).
  const [joinState, setJoinState] = useState<
    "inactive" | "active" | "done" | "failed" | "timeout"
  >(() => (!emptyMode && coldStartJobId ? "active" : "inactive"));
  const [joinPhase, setJoinPhase] = useState<string | null>(null);

  // Diagnostics panel visibility: UX test mode OR an explicit `?debug=1`.
  // Never visible in normal prototype use; carries no end-user copy.
  // INTERNAL / manual-E2E aid only — `?debug=1` deliberately works outside UX
  // test mode so operators can inspect a live deploy without a rebuild. It
  // exposes no secrets (only `_meta` diagnostics already sent to the client).
  // TODO(slice-4-followup): if we ever want this locked to recordings/walkthroughs,
  // drop the `?debug=1` clause and gate on `isUxTestMode` alone.
  const debugMode = isUxTestMode || searchParams.get("debug") === "1";

  const tagSections = useMemo(() => aggregateTagSections(stories), [stories]);
  // Phase 1.2: displayed pills = (current visible story tags) ∩ (saved
  // settings vocabulary).  Re-derives whenever `stories` change (incl. the
  // heartbeat overlay, which flows through `setStories`) or settings resolve.
  // While `settingsVocab` is null (unfetched / fetch failed), every axis
  // intersects to empty — the conservative posture that guarantees no
  // out-of-settings pill is ever introduced.  Filtering still uses the full,
  // unmodified `tagSections`/story tags via `storyMatchesSelection`.
  const displayedTagSections = useMemo<TagSections>(() => {
    if (!settingsVocab) return { topics: [], keywords: [], geographies: [] };
    const intersect = (values: string[], allowed: string[]) => {
      const allow = new Set(allowed);
      return values.filter((v) => allow.has(v));
    };
    return {
      topics: intersect(tagSections.topics, settingsVocab.topics),
      keywords: intersect(tagSections.keywords, settingsVocab.keywords),
      geographies: intersect(tagSections.geographies, settingsVocab.geographies),
    };
  }, [tagSections, settingsVocab]);
  const tagSelection = useMemo<TagSelection>(
    () => ({ topics: selectedTopics, keywords: selectedKeywords, geographies: selectedGeographies }),
    [selectedTopics, selectedKeywords, selectedGeographies]
  );
  const allActive = isEmptySelection(tagSelection);

  // Phase 6: trust-first signal for the "stories exist but every tag axis is
  // empty" state.  The pill row already suppresses empty sections (and their
  // separators) — this caption surfaces what's happening to the reader so
  // the missing pills don't read as a glitch.  Suppressed entirely when at
  // least one pill section is non-empty OR when the dashboard hasn't loaded
  // any stories yet (the empty-stories state has its own copy below).
  const hasAnyTagSection =
    displayedTagSections.topics.length > 0 ||
    displayedTagSections.keywords.length > 0 ||
    displayedTagSections.geographies.length > 0;
  const showNoTagsCaption = stories.length > 0 && !hasAnyTagSection;

  const filtered = useMemo(
    () =>
      stories
        .filter((s) => storyMatchesSelection(s, tagSelection))
        .map((s) => ({ story: s, sig: deriveSignals(s) })),
    [stories, tagSelection]
  );

  const counts = useMemo(() => {
    const out = { rising: 0, steady: 0, falling: 0 };
    filtered.forEach(({ sig }) => (out[sig.trend] += 1));
    return out;
  }, [filtered]);

  const headline = useMemo(() => buildHeadline(counts), [counts]);

  const activeSourcePair = useMemo(
    () => (activeSourceId ? findSourceInStories(stories, activeSourceId) : null),
    [stories, activeSourceId]
  );
  const activeSource: Source | null = activeSourcePair?.source ?? null;

  const railOpen = !!activeSource;

  useEffect(() => {
    trackDashboardViewed();
  }, []);

  // Phase 1.2: fetch the saved settings vocabulary once on load so the pill
  // row can be intersected against it (see `displayedTagSections`).  Reuses
  // the existing settings API client.  On failure we leave `settingsVocab`
  // null — the dashboard keeps rendering stories and its load/error UX as
  // before, and the pill row conservatively shows only "All".
  useEffect(() => {
    // emptyMode (?empty=1) renders a static empty block with no stories — the
    // pill row is moot, so skip the fetch (mirrors the load/heartbeat effects).
    if (emptyMode) return;
    let canceled = false;
    fetchSettingsPayload()
      .then((payload) => {
        if (canceled) return;
        setSettingsVocab({
          topics: payload.topics ?? [],
          keywords: payload.keywords ?? [],
          geographies: payload.geographies ?? [],
        });
      })
      .catch(() => {
        if (canceled) return;
        setSettingsVocab(null);
      });
    return () => {
      canceled = true;
    };
  }, [emptyMode]);

  useEffect(() => {
    if (expandedId) trackStoryExpanded(expandedId);
  }, [expandedId]);

  useEffect(() => {
    if (emptyMode) return;
    // Slice 9: while JOINed to an in-flight cold-start refresh, the poll effect
    // owns the screen — do NOT load or fire a duplicate POST /refresh yet.  The
    // loader re-runs (joinState in deps) once the join settles done/failed/timeout.
    if (joinState === "active") return;
    let canceled = false;
    setIsLoading(true);
    setLoadError(null);
    // Slice 9: a JOIN that settled `done`/`failed` loads via GET (the prefetch
    // already ran the refresh) — never a duplicate POST.  `timeout`/`inactive`
    // keep the existing routing below.
    const joinResolvedToGet = joinState === "done" || joinState === "failed";
    // Slice 10: any load triggered by a retry (reloadCounter bumped — only
    // `handleRetry` does this) runs the DEFAULT-profile refresh, overriding every
    // other routing path (join/forceRefresh/bootstrap).  A retry is always a
    // refresh attempt.
    const isRetry = reloadCounter > 0;
    // POST-style attempts (retry, bootstrap, OR forceRefresh) count as refresh
    // attempts: they delegate to the server's refresh executor, so the global
    // `isRefreshing` flag must reflect them and the anchor advances on settle.
    // GET serves the persisted snapshot — it is NOT a refresh attempt, so it
    // must not toggle the in-flight flag and must not advance the anchor (GET
    // only seeds when nothing is set yet).  Local `isLoading` covers the GET
    // path's own loading copy.
    const isPostAttempt = isRetry || (!joinResolvedToGet && (useBootstrap || forceRefresh));
    const attemptToken = isPostAttempt ? recordAttemptStart() : null;
    // `bootstrapResult` is only set when the bootstrap POST resolves — used to
    // read its `decision` for the clock-advance rule.  `renderedResult` is
    // whatever we actually painted (the POST result OR the recovered GET
    // result).  `postFailed` records that the POST loader threw (even when a
    // GET recovery later succeeds) so the attempt still counts as a real
    // refresh that advances the clock.
    let bootstrapResult: DashboardBootstrapResult | null = null;
    let renderedResult: DashboardFetchResult | null = null;
    let postFailed = false;

    const applyResult = (result: DashboardFetchResult) => {
      renderedResult = result;
      const { payload } = result;
      setStories(payload.stories.map(dtoToStory));
      setLoadError(null);
      setHasLoadedOnce(true);
      setClusteringFailed(result.clusteringFailed);
      setClusteringFailureReason(result.clusteringFailureReason);
      // Phase 4 · Step 3: capture the refresh fail-safe status so the render
      // path can show a failure banner / failure-aware empty state.
      setRefreshFailsafe({
        refreshStatus: result.refreshStatus,
        refreshFailure: result.refreshFailure,
        usedPriorSnapshot: result.usedPriorSnapshot,
        // B6: deterministic-rescue (B3) + background-upgrade (B5) signals so the
        // render path can show the non-blocking "degraded" cue and the debug
        // panel can report the rescue.
        usedDeterministicClustering: result.usedDeterministicClustering,
        clusteringLlmFailed: result.clusteringLlmFailed,
        deterministicClusteringDiagnostics: result.deterministicClusteringDiagnostics,
        upgradeRefreshScheduled: result.upgradeRefreshScheduled,
        upgradeRefreshReason: result.upgradeRefreshReason,
      });
      setRunDiagnostics({
        clusteringAttempts: result.clusteringAttempts,
        selection: result.selection,
        funnel: result.funnel,
        recall: result.recall,
        clusterSplit: result.clusterSplit,
        overflowCap: result.overflowCap,
        clusterCap: result.clusterCap,
        reclusterExecution: result.reclusterExecution,
        reclusterQueueCount: result.reclusterQueueCount,
      });
      // Slice 5: capture progressive-enrichment state so the poll effect can
      // start (deferred + pending) or stay idle.
      setWhyEnrichment(result.whyEnrichment);
      // First-paint seed.  GET responses never advance an existing anchor
      // (post-seed remounts are no-ops); bootstrap `served_fresh_snapshot`
      // also lands here so a brand-new session still gets a timestamp from
      // the first response.  Refresh-style attempts additionally advance the
      // clock via `recordAttemptFinished` below.
      seedAnchorIfMissing(result);
    };

    const run = async () => {
      try {
        // Routing:
        //   retry        → POST /refresh?profile=default (Slice 10): every
        //     user-triggered retry runs the default profile, overriding any
        //     prior path (join/forceRefresh/bootstrap/timeout/failed).
        //   join done/failed → GET (the prefetch already ran the refresh; never
        //     POST a duplicate — failed loads the fail-closed/empty snapshot).
        //   forceRefresh → POST /refresh directly (Onboarding handoff): never
        //     reuse a stale fresh snapshot for the user's first view.
        //   useBootstrap → POST /bootstrap (Landing/Onboarding freshness check).
        //   otherwise    → GET (cheap persisted snapshot for in-app nav).
        if (isRetry) {
          renderedResult = await refreshDashboard({ endpoint: RETRY_DEFAULT_REFRESH_ENDPOINT });
        } else if (joinResolvedToGet) {
          renderedResult = await fetchDashboardWithMeta();
        } else if (forceRefresh) {
          // Slice 4: request the interactive fast-path profile for the first
          // post-onboarding paint (server reads `?interactive=1`).
          renderedResult = await refreshDashboard({ endpoint: INTERACTIVE_REFRESH_ENDPOINT });
        } else if (useBootstrap) {
          const r = await bootstrapDashboard();
          bootstrapResult = r;
          renderedResult = r;
        } else {
          renderedResult = await fetchDashboardWithMeta();
        }
        if (canceled) return;
        applyResult(renderedResult);
      } catch (error: unknown) {
        // Slice 2 silent recovery: a POST loader (bootstrap/refresh) that fails
        // after its retries gets ONE best-effort GET before we surface any
        // error UI.  If the GET serves a contract-valid snapshot, render it
        // silently — no full-page error, no banner, no toast.  GET-path loads
        // have no recovery leg (they ARE the snapshot read), so they fall
        // straight through to the existing error behavior.
        if (isPostAttempt) {
          postFailed = true;
          const recovered = canceled ? null : await recoverDashboardViaGet();
          if (canceled) return;
          if (recovered) {
            applyResult(recovered);
            return;
          }
        }
        if (canceled) return;
        const message = error instanceof Error ? error.message : "Failed to load dashboard data.";
        setLoadError(message);
        trackSourceOpenError({ message, code: "dashboard_payload_load_failed" });
        // Only surface a toast when there's prior fresh data on screen — the
        // full-page error block already conveys the failure on first load.
        if (stories.length > 0) {
          notifyError("We couldn't refresh stories. Showing previous run.");
        }
      } finally {
        if (attemptToken !== null) {
          // Settle the in-flight slot exactly once per loader run (no
          // double-counting across the POST + recovery legs).  The
          // result-aware settle prefers the server-stamped `lastCheckedAt`
          // when present, falling back to client `now()`.
          //
          // Clock-advance rule:
          //   forceRefresh → always advance (a /refresh attempt always ran).
          //   bootstrap    → delegate to `shouldAdvanceClockForBootstrap`.  A
          //     POST that failed (even when recovered via GET) reports
          //     `failed: true`, which advances — the recovery doesn't undo the
          //     fact that a refresh was attempted.  Only a successful
          //     `served_fresh_snapshot` is a no-op.
          const advanceClock =
            isRetry || forceRefresh
              ? true
              : shouldAdvanceClockForBootstrap({
                  failed: postFailed,
                  decision: bootstrapResult?.decision ?? null,
                });
          recordAttemptFinished(attemptToken, {
            result: renderedResult,
            advanceClock,
          });
        }
        if (!canceled) setIsLoading(false);
      }
    };

    void run();
    return () => {
      canceled = true;
    };
    // `stories.length` intentionally excluded — only used to gate the toast.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    emptyMode,
    joinState,
    useBootstrap,
    forceRefresh,
    reloadCounter,
    seedAnchorIfMissing,
    recordAttemptStart,
    recordAttemptFinished,
  ]);

  // ─── Slice 9: poll the cold-start prefetch job while JOINed ─────────────────
  // Polls the Slice 7 status endpoint every 2s up to a 60s budget.  Terminal
  // `done`/`failed` settle the join (the loader then renders via GET — no
  // duplicate POST).  At the budget we fall back to the normal loader path with
  // a non-blocking warning.  Transient poll errors are swallowed and retried
  // until the deadline so a flaky tick never wedges the join.
  useEffect(() => {
    if (joinState !== "active" || !coldStartJobId) return;
    let canceled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const deadline = Date.now() + JOIN_MAX_MS;
    // End the join without a terminal job result (budget elapsed or terminal
    // 403/404) and hand off to the normal loader with one non-blocking warning.
    // Reuses the `timeout` state so the loader's fallback routing is identical
    // for both causes.
    const fallbackToLoader = () => {
      setJoinState("timeout");
      notifyWarning(JOIN_FALLBACK_WARNING);
    };
    const tick = async () => {
      if (canceled) return;
      try {
        const status = await fetchRefreshStatus(coldStartJobId);
        if (canceled) return;
        setJoinPhase(status.phase);
        if (status.status === "done") {
          setJoinState("done");
          return;
        }
        if (status.status === "failed") {
          setJoinState("failed");
          return;
        }
      } catch (error) {
        // Terminal job-unavailable (forbidden / not found) can never recover by
        // retrying — short-circuit to the fallback path immediately rather than
        // stalling the progress UI for the full budget.  All other errors
        // (network, contract parse, other HTTP statuses like 500) are treated as
        // transient and retried until the deadline below.
        if (
          error instanceof DashboardFetchError &&
          error.kind === "http" &&
          (error.status === 403 || error.status === 404)
        ) {
          if (canceled) return;
          fallbackToLoader();
          return;
        }
        // Transient poll failure — keep trying until the deadline.
      }
      if (canceled) return;
      if (Date.now() >= deadline) {
        fallbackToLoader();
        return;
      }
      timer = setTimeout(tick, JOIN_POLL_INTERVAL_MS);
    };
    void tick();
    return () => {
      canceled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joinState, coldStartJobId]);

  // App-scope heartbeat (lib/refresh-heartbeat) drives the 60-minute refresh
  // attempt guarantee; here we just overlay its successful result onto the
  // currently-rendered stories so a long-lived dashboard view doesn't show
  // stale content even though the header timestamp moved forward.
  useEffect(() => {
    if (emptyMode || !heartbeatResult) return;
    setStories(heartbeatResult.payload.stories.map(dtoToStory));
    setLoadError(null);
    setHasLoadedOnce(true);
    setClusteringFailed(heartbeatResult.clusteringFailed);
    setClusteringFailureReason(heartbeatResult.clusteringFailureReason);
    setRunDiagnostics({
      clusteringAttempts: heartbeatResult.clusteringAttempts,
      selection: heartbeatResult.selection,
      funnel: heartbeatResult.funnel,
      recall: heartbeatResult.recall,
      clusterSplit: heartbeatResult.clusterSplit,
      overflowCap: heartbeatResult.overflowCap,
      clusterCap: heartbeatResult.clusterCap,
      reclusterExecution: heartbeatResult.reclusterExecution,
      reclusterQueueCount: heartbeatResult.reclusterQueueCount,
    });
    setWhyEnrichment(heartbeatResult.whyEnrichment);
  }, [emptyMode, heartbeatResult]);

  // ─── Slice 5: poll for progressive whyItMatters upgrades ───────────────────
  // While the latest fetch reports a DEFERRED enrichment with stories still
  // pending, poll GET /api/dashboard on a short interval and patch each visible
  // story card's `whyItMatters` IN PLACE (matched by id) — no full-page reset,
  // so a reader with a card expanded sees the copy upgrade live.  Stops as soon
  // as `pending` hits 0 (all upgraded) or the timeout budget is exhausted.  The
  // effect gate is a stable boolean, so it doesn't churn the interval while
  // pending is unchanged; the interval callback flips the gate when done.
  const whyPending =
    !emptyMode && whyEnrichment?.deferred === true && (whyEnrichment?.pending ?? 0) > 0;
  useEffect(() => {
    if (!whyPending) return;
    let canceled = false;
    // In-flight guard: a single GET poll can outlast the interval, so each tick
    // is skipped while a prior request is still resolving — preventing
    // overlapping/stacked GETs. Released in `finally` so a thrown/aborted poll
    // can't wedge the loop shut.
    let inFlight = false;
    const deadline = Date.now() + WHY_POLL_BUDGET_MS;
    const id = setInterval(async () => {
      if (canceled) return;
      if (Date.now() > deadline) {
        // Budget exhausted: stop ACTIVE polling, keep whatever copy is on
        // screen (grounded/template fallback or partial). `pollExhausted` marks
        // that this is NOT a permanent lock — a later background refresh
        // (heartbeat / next interactive entry) still upgrades the copy in place
        // (Slice 6 follow-through). Clearing `deferred` halts this effect.
        clearInterval(id);
        setWhyEnrichment((prev) => (prev ? { ...prev, deferred: false, pollExhausted: true } : prev));
        return;
      }
      if (inFlight) return; // a previous poll is still running — skip this tick
      inFlight = true;
      try {
        const res = await fetchDashboardWithMeta();
        if (canceled) return;
        // Patch whyItMatters in place by story id — preserves order, expand
        // state, scroll position, and the open source rail.
        const byId = new Map(res.payload.stories.map((s) => [s.id, s.whyItMatters]));
        setStories((prev) =>
          prev.map((s) => (byId.has(s.id) ? { ...s, whyItMatters: byId.get(s.id) as string } : s))
        );
        setWhyEnrichment(res.whyEnrichment);
        if (!res.whyEnrichment || res.whyEnrichment.pending <= 0) {
          clearInterval(id); // all upgraded → stop
        }
      } catch {
        // Transient poll failure — keep the fallback copy and retry next tick
        // until the budget is exhausted. Never surfaces an error to the user.
      } finally {
        // Always release the in-flight guard so the next tick can proceed.
        inFlight = false;
      }
    }, WHY_POLL_INTERVAL_MS);
    return () => {
      canceled = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [whyPending]);

  const handleRetry = useCallback(() => {
    // Slice 10: a retry always abandons any in-flight JOIN and starts a fresh
    // default-profile refresh path (the loader routes reloadCounter>0 loads to
    // RETRY_DEFAULT_REFRESH_ENDPOINT).  Clearing the join state deterministically
    // prevents a stale poll/progress from gating the retry-triggered load.
    setJoinState("inactive");
    setJoinPhase(null);
    setReloadCounter((n) => n + 1);
  }, []);

  // Footer countdown — re-evaluates against current client time.  Tick at
  // 30s granularity so the minute-rounded display stays accurate without
  // burning a frame every second.
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  // Footer countdown and the AppHeader's "Last refresh" badge derive from
  // the same anchor (`lastAttemptAt`).  Math is consistent by construction:
  // both surfaces reflect the most recent attempt settlement (success,
  // no-op, or failure).
  //
  // Copy precedence:
  //   1. `isRefreshing` (a POST refresh-style attempt is in flight) →
  //      "Refreshing now…".  Bootstrap and heartbeat ticks land here.
  //   2. `isLoading` (a GET load is in flight) → "Loading stories…".  GET
  //      is NOT a refresh attempt, so the copy avoids implying a refresh.
  //   3. `lastAttemptAt` null (no anchor has been established yet) → "—".
  //      A GET that returned no parseable timestamps must not synthesize a
  //      countdown from client time alone (GET never invents an anchor).
  //   4. Otherwise: countdown to `lastAttemptAt + REFRESH_INTERVAL_MS`.
  const footerText = useMemo(() => {
    if (isRefreshing) return "Refreshing now…";
    if (isLoading) return "Loading stories…";
    if (lastAttemptAt === null) return "—";
    const nextAttemptAt = lastAttemptAt + REFRESH_INTERVAL_MS;
    // If timers are throttled and we're already due, keep showing a bounded
    // countdown state until an actual in-flight attempt toggles isRefreshing.
    const remainingMin = Math.max(1, Math.ceil((nextAttemptAt - nowMs) / 60_000));
    return `Next refresh in ~${remainingMin}m`;
  }, [lastAttemptAt, isRefreshing, isLoading, nowMs]);

  const handleReset = () => {
    setSelectedTopics(new Set());
    setSelectedKeywords(new Set());
    setSelectedGeographies(new Set());
  };

  const toggleTopic = (t: string) => setSelectedTopics((prev) => toggleInSet(prev, t));
  const toggleKeyword = (k: string) => setSelectedKeywords((prev) => toggleInSet(prev, k));
  const toggleGeography = (g: string) => setSelectedGeographies((prev) => toggleInSet(prev, g));

  const handleOpenSource = (storyId: string, sourceId: string) => {
    trackSourceOpened(storyId, sourceId);
    setActiveSourceId(sourceId);
  };

  return (
    <>
      {/* Layout shell — pushes feed on lg+ when source rail is open */}
      <div
        className={`mx-auto grid max-w-[1400px] transition-[grid-template-columns] duration-300 ease-editorial ${
          railOpen ? "grid-cols-1 lg:grid-cols-[minmax(0,1fr)_480px]" : "grid-cols-1"
        }`}
      >
        <section className="min-w-0">
          {/* Header zone */}
          <div className="border-b border-rule/60 px-6 py-7">
            <h1 className="font-display text-[32px] font-semibold leading-tight tracking-tight">
              {headline}
            </h1>
            {joinState === "active" ? (
              <p
                className="mt-2 font-mono text-[11px] uppercase tracking-wider text-muted-foreground"
                data-testid="cold-start-progress"
                role="status"
              >
                {(joinPhase && JOIN_PHASE_COPY[joinPhase]) || JOIN_PROGRESS_FALLBACK}
              </p>
            ) : isLoading ? (
              <p className="mt-2 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
                Loading stories…
              </p>
            ) : null}

            {/* Pill row — Phase 6: dynamic sections derived from current
                payload's stories.  Order: All → Topics → Keywords → Geographies.
                Sections with zero tags are hidden entirely; separators only
                appear between non-empty sections.  When EVERY section is
                empty (stories exist but no tags surface), a quiet
                trust-first caption surfaces alongside the lone "All" pill
                so the missing pills don't read as a glitch. */}
            <div
              className="mt-5 flex flex-wrap items-center gap-1.5"
              data-testid="header-pill-row"
              role="group"
              aria-label="Filter stories by tag"
            >
              <Pill active={allActive} onClick={handleReset} testId="pill-all">
                All
              </Pill>
              {showNoTagsCaption && (
                <span
                  className="ml-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground"
                  data-testid="pill-row-empty-caption"
                  role="status"
                >
                  No tag groups yet
                </span>
              )}
              {displayedTagSections.topics.length > 0 && (
                <>
                  <span className="mx-1 text-rule" aria-hidden="true">·</span>
                  {displayedTagSections.topics.map((t) => (
                    <Pill
                      key={`topic-${t}`}
                      active={selectedTopics.has(t)}
                      onClick={() => toggleTopic(t)}
                      testId={`pill-topic-${t}`}
                    >
                      {t}
                    </Pill>
                  ))}
                </>
              )}
              {displayedTagSections.keywords.length > 0 && (
                <>
                  <span className="mx-1 text-rule" aria-hidden="true">·</span>
                  {displayedTagSections.keywords.map((k) => (
                    // Display-only formatting: `k` is the canonical raw value
                    // used for key/testId/selection/filtering; only the pill's
                    // visible label is title-cased so lowercase settings
                    // keywords ("oil") look consistent next to canonical
                    // topics/geographies in the row.
                    <Pill
                      key={`keyword-${k}`}
                      active={selectedKeywords.has(k)}
                      onClick={() => toggleKeyword(k)}
                      testId={`pill-keyword-${k}`}
                    >
                      {formatKeywordLabel(k)}
                    </Pill>
                  ))}
                </>
              )}
              {displayedTagSections.geographies.length > 0 && (
                <>
                  <span className="mx-1 text-rule" aria-hidden="true">·</span>
                  {displayedTagSections.geographies.map((g) => (
                    <Pill
                      key={`geo-${g}`}
                      active={selectedGeographies.has(g)}
                      onClick={() => toggleGeography(g)}
                      testId={`pill-geo-${g}`}
                    >
                      {g}
                    </Pill>
                  ))}
                </>
              )}
            </div>
          </div>

          {/* Debug-only run diagnostics (Slice 3) — gated by UX test mode or
              ?debug=1. Never visible in normal prototype use. */}
          {debugMode && (
            <DashboardRunDiagnostics
              clusteringFailed={clusteringFailed}
              clusteringFailureReason={clusteringFailureReason}
              clusteringAttempts={runDiagnostics?.clusteringAttempts ?? null}
              funnel={runDiagnostics?.funnel ?? null}
              recall={runDiagnostics?.recall ?? null}
              selection={runDiagnostics?.selection ?? null}
              clusterSplit={runDiagnostics?.clusterSplit ?? null}
              overflowCap={runDiagnostics?.overflowCap ?? null}
              clusterCap={runDiagnostics?.clusterCap ?? null}
              reclusterExecution={runDiagnostics?.reclusterExecution ?? null}
              reclusterQueueCount={runDiagnostics?.reclusterQueueCount ?? null}
              refreshFailsafe={refreshFailsafe}
            />
          )}

          {/* Inline banner when a refresh failed but a previous run is on-screen */}
          {loadError && stories.length > 0 && (
            <ErrorState variant="dense" onRetry={handleRetry} />
          )}

          {/* Phase 4 · Step 3: non-blocking fail-safe banner — the refresh failed
              (HTTP-ok but refreshStatus="failed") and the server EXPLICITLY preserved
              a prior snapshot (usedPriorSnapshot=true), so the on-screen stories are
              known prior-snapshot continuity. The usedPriorSnapshot guard keeps the
              "Showing your last results" copy honest: we never show it for a
              hypothetical failed+stories case where continuity isn't guaranteed.
              Distinct from the fetch-error banner above (which is for a failed HTTP
              fetch). */}
          {!loadError &&
            refreshFailsafe?.refreshStatus === "failed" &&
            refreshFailsafe?.usedPriorSnapshot === true &&
            stories.length > 0 && (
              <RefreshFailedBanner onRetry={handleRetry} />
            )}

          {/* B6: non-blocking DEGRADED cue — the LLM clustering stage failed but
              the deterministic fallback (B3) published bounded stories, which we
              render normally below. This is NOT a hard failure: a subtle banner
              tells the user a better grouping is coming (when the B5 background
              upgrade was scheduled). Gated on stories present so it never shows
              over an empty/failed state. */}
          {!loadError &&
            refreshFailsafe?.refreshStatus === "degraded" &&
            stories.length > 0 && (
              <RefreshDegradedBanner
                upgradeScheduled={refreshFailsafe?.upgradeRefreshScheduled === true}
              />
            )}

          {/* Feed zone — distinguishes loading / fetch error / legitimate empty */}
          {(() => {
            // Initial load (or retry) with no on-screen data yet.
            if (isLoading && stories.length === 0) {
              return (
                <div data-testid="dashboard-loading">
                  <LoadingState variant="dense" />
                </div>
              );
            }
            // Fetch failed and we have nothing to show — full error block, retry only.
            if (loadError && stories.length === 0) {
              return (
                <div data-testid="dashboard-error">
                  <ErrorState variant="briefing" onRetry={handleRetry} />
                </div>
              );
            }
            // Clustering failed (fail-closed): 0 stories published on purpose
            // after a successful fetch. Distinct copy from a quiet beat so the
            // user knows to retry rather than reading it as "nothing matched".
            if (
              !isLoading &&
              !loadError &&
              stories.length === 0 &&
              hasLoadedOnce &&
              clusteringFailed
            ) {
              return (
                <ClusteringFailedState
                  onRetry={handleRetry}
                  reason={clusteringFailureReason}
                />
              );
            }
            // Phase 4 · Step 3: refresh failed (Step 2 contract) with no stories
            // to show and no prior snapshot to preserve. Failure-aware empty state
            // — must NOT read as a quiet beat. Ordered after the clustering branch
            // so a clustering fail-closed keeps its dedicated copy; this catches
            // the broader failure surface (e.g. a pipeline exception).
            if (
              !isLoading &&
              !loadError &&
              stories.length === 0 &&
              hasLoadedOnce &&
              refreshFailsafe?.refreshStatus === "failed"
            ) {
              return <RefreshFailedState onRetry={handleRetry} />;
            }
            // Backend returned 0 stories (legitimately empty after a successful fetch).
            if (!isLoading && !loadError && stories.length === 0 && hasLoadedOnce) {
              return (
                <div data-testid="dashboard-empty">
                  <EmptyState variant="briefing" />
                </div>
              );
            }
            // Stories present, but current filters knock the visible list to zero.
            if (filtered.length === 0) {
              return <EmptyState variant="dense" onRetry={handleReset} />;
            }
            return (
              <ul className="divide-y divide-rule/60">
                {filtered.map(({ story, sig }) => (
                  <li key={story.id}>
                    <StoryCard
                      story={story}
                      sig={sig}
                      expanded={expandedId === story.id}
                      onToggle={() => setExpandedId(expandedId === story.id ? null : story.id)}
                      onOpenSource={(sourceId) => handleOpenSource(story.id, sourceId)}
                    />
                  </li>
                ))}
              </ul>
            );
          })()}

          {!isUxTestMode && (
            <div className="px-6 py-8 text-center">
              <p
                data-testid="refresh-footer"
                className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground"
              >
                {footerText}
              </p>
            </div>
          )}
        </section>

        {/* Desktop source reader rail (lg+) */}
        {railOpen && (
          <aside className="hidden lg:block">
            <div className="sticky top-16 h-[calc(100vh-4rem)]">
              <SourceReader
                source={activeSource}
                onClose={() => setActiveSourceId(null)}
              />
            </div>
          </aside>
        )}
      </div>

      {/* Mobile/tablet overlay (<lg) — slides in from the right */}
      <div
        onClick={() => setActiveSourceId(null)}
        className={`fixed inset-0 top-16 z-40 bg-foreground/20 backdrop-blur-[1px] transition-opacity duration-300 lg:hidden ${
          railOpen ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
        aria-hidden={!railOpen}
      />
      <aside
        className={`fixed right-0 top-16 z-50 h-[calc(100vh-4rem)] w-full max-w-[520px] transform shadow-paper transition-transform duration-300 ease-editorial lg:hidden ${
          railOpen ? "translate-x-0" : "translate-x-full"
        }`}
        aria-hidden={!railOpen}
      >
        <SourceReader
          source={activeSource}
          onClose={() => setActiveSourceId(null)}
        />
      </aside>
    </>
  );
}

function findSourceInStories(
  stories: Story[],
  sourceId: string
): { story: Story; source: Source } | null {
  for (const story of stories) {
    const source = story.sources.find((s) => s.id === sourceId);
    if (source) return { story, source };
  }
  return null;
}

export function buildHeadline(counts: {
  rising: number;
  steady: number;
  falling: number;
}): string {
  const order = ["rising", "steady", "falling"] as const;
  const present = order.filter((state) => counts[state] > 0);
  if (present.length === 0) return "Quiet for this view.";
  return present
    .map((state, idx) => {
      const n = counts[state];
      if (idx === 0) return `${n} ${n === 1 ? "narrative" : "narratives"} ${state}`;
      return `${n} ${state}`;
    })
    .join(" · ");
}

function Pill({
  active,
  onClick,
  children,
  testId,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      aria-pressed={active}
      className={`rounded-full px-3 py-1 text-[12px] font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground ${
        active
          ? "bg-foreground text-background"
          : "text-muted-foreground hover:bg-secondary hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}
