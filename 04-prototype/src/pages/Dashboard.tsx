import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import { Source, Story } from "@/data/stories";
import { deriveSignals } from "@/lib/derive";
import StoryCard from "@/components/StoryCard";
import SourceReader from "@/components/SourceReader";
import { EmptyState, ErrorState, LoadingState } from "@/components/StateBlocks";
import {
  trackDashboardViewed,
  trackSourceOpenError,
  trackSourceOpened,
  trackStoryExpanded,
} from "@/lib/analytics";
import {
  bootstrapDashboard,
  fetchDashboardWithMeta,
  type DashboardBootstrapDecision,
  type DashboardBootstrapResult,
  type DashboardFetchResult,
} from "@/lib/api";
import { formatKeywordLabel } from "@/lib/format";
import {
  aggregateTagSections,
  isEmptySelection,
  storyMatchesSelection,
  toggleInSet,
  type TagSelection,
} from "@/lib/dashboard-filters";
import { type StoryDto } from "@tempo/contracts";
import { notifyError } from "@/lib/notify";
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

function dtoToStory(dto: StoryDto): Story {
  return {
    id: dto.id,
    title: dto.title,
    geographies: dto.geographies,
    topic: dto.topic,
    // Meta-story fields PR (Prompt 2): the contract now ships `subtitle` as
    // the deck line under the title.  API legacy adapter (Prompt 1) lifts
    // any stale `takeaway` value into `subtitle` at the snapshot read
    // boundary, so the client can read `subtitle` strictly.
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
  const useBootstrap = (location.state as { bootstrap?: boolean } | null)?.bootstrap === true;

  // Phase 6: dynamic, multi-select header pill state (one Set per section).
  // Empty sets across all three sections = "All" (no filters applied).
  const [selectedTopics, setSelectedTopics] = useState<ReadonlySet<string>>(() => new Set());
  const [selectedKeywords, setSelectedKeywords] = useState<ReadonlySet<string>>(() => new Set());
  const [selectedGeographies, setSelectedGeographies] = useState<ReadonlySet<string>>(() => new Set());
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [activeSourceId, setActiveSourceId] = useState<string | null>(null);
  // Stories are seeded empty — no static demo fallback. The dashboard renders
  // Loading/Empty/Error blocks until the backend supplies a payload.
  const [stories, setStories] = useState<Story[]>([]);
  const [isLoading, setIsLoading] = useState(!emptyMode);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(emptyMode);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadCounter, setReloadCounter] = useState(0);

  const tagSections = useMemo(() => aggregateTagSections(stories), [stories]);
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
    tagSections.topics.length > 0 ||
    tagSections.keywords.length > 0 ||
    tagSections.geographies.length > 0;
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
  const activeSourceStory: Story | null = activeSourcePair?.story ?? null;

  const railOpen = !!activeSource;

  useEffect(() => {
    trackDashboardViewed();
  }, []);

  useEffect(() => {
    if (expandedId) trackStoryExpanded(expandedId);
  }, [expandedId]);

  useEffect(() => {
    if (emptyMode) return;
    let canceled = false;
    setIsLoading(true);
    setLoadError(null);
    // Only bootstrap counts as a refresh-style attempt: it can delegate to
    // the server's refresh executor, so the global `isRefreshing` flag must
    // reflect it.  GET serves the persisted snapshot — it is NOT a refresh
    // attempt, so it must not toggle the in-flight flag and must not
    // advance the anchor (GET only seeds when nothing is set yet).  Local
    // `isLoading` covers the GET path's own loading copy.
    const attemptToken = useBootstrap ? recordAttemptStart() : null;
    // Captured inside the promise chain so `.finally` can read the resolved
    // result without re-awaiting.  `null` on the GET path (where we don't
    // settle an attempt slot at all) and on the failure path (where the
    // server gave us nothing usable).
    let bootstrapResult: DashboardBootstrapResult | null = null;
    let loaderResult: DashboardFetchResult | null = null;
    let loaderFailed = false;

    // Phase 5: bootstrap path runs the (potentially expensive) refresh check
    // server-side and falls back to a fresh snapshot when ≤ 60 min old.  GET
    // path stays cheap and is used for every other dashboard load.
    const loader: Promise<DashboardFetchResult | DashboardBootstrapResult> = useBootstrap
      ? bootstrapDashboard()
      : fetchDashboardWithMeta();

    loader
      .then((result) => {
        if (canceled) return;
        loaderResult = result;
        if (useBootstrap) bootstrapResult = result as DashboardBootstrapResult;
        const { payload } = result;
        setStories(payload.stories.map(dtoToStory));
        setLoadError(null);
        setHasLoadedOnce(true);
        // First-paint seed.  GET responses never advance an existing
        // anchor (post-seed remounts are no-ops); bootstrap
        // `served_fresh_snapshot` also lands here so a brand-new session
        // still gets a timestamp from the first response.  Bootstrap
        // `ran_refresh` will additionally advance the clock via
        // `recordAttemptFinished` below.
        seedAnchorIfMissing(result);
      })
      .catch((error: unknown) => {
        if (canceled) return;
        loaderFailed = true;
        const message = error instanceof Error ? error.message : "Failed to load dashboard data.";
        setLoadError(message);
        trackSourceOpenError({ message, code: "dashboard_payload_load_failed" });
        // Only surface a toast when there's prior fresh data on screen — the
        // full-page error block already conveys the failure on first load.
        if (stories.length > 0) {
          notifyError("We couldn't refresh stories. Showing previous run.");
        }
      })
      .finally(() => {
        if (attemptToken !== null) {
          // Bootstrap path — settle the in-flight slot.  The result-aware
          // settle prefers the server-stamped `lastCheckedAt` when present,
          // falling back to client `now()` for failures and legacy
          // responses.  The advance/no-op decision is delegated to
          // `shouldAdvanceClockForBootstrap` (see helper for the matrix).
          recordAttemptFinished(attemptToken, {
            result: loaderResult,
            advanceClock: shouldAdvanceClockForBootstrap({
              failed: loaderFailed,
              decision: bootstrapResult?.decision ?? null,
            }),
          });
        }
        if (canceled) return;
        setIsLoading(false);
      });
    return () => {
      canceled = true;
    };
    // `stories.length` intentionally excluded — only used to gate the toast.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    emptyMode,
    useBootstrap,
    reloadCounter,
    seedAnchorIfMissing,
    recordAttemptStart,
    recordAttemptFinished,
  ]);

  // App-scope heartbeat (lib/refresh-heartbeat) drives the 60-minute refresh
  // attempt guarantee; here we just overlay its successful result onto the
  // currently-rendered stories so a long-lived dashboard view doesn't show
  // stale content even though the header timestamp moved forward.
  useEffect(() => {
    if (emptyMode || !heartbeatResult) return;
    setStories(heartbeatResult.payload.stories.map(dtoToStory));
    setLoadError(null);
    setHasLoadedOnce(true);
  }, [emptyMode, heartbeatResult]);

  const handleRetry = useCallback(() => {
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
            {isLoading && (
              <p className="mt-2 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
                Loading stories…
              </p>
            )}

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
              {tagSections.topics.length > 0 && (
                <>
                  <span className="mx-1 text-rule" aria-hidden="true">·</span>
                  {tagSections.topics.map((t) => (
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
              {tagSections.keywords.length > 0 && (
                <>
                  <span className="mx-1 text-rule" aria-hidden="true">·</span>
                  {tagSections.keywords.map((k) => (
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
              {tagSections.geographies.length > 0 && (
                <>
                  <span className="mx-1 text-rule" aria-hidden="true">·</span>
                  {tagSections.geographies.map((g) => (
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

          {/* Inline banner when a refresh failed but a previous run is on-screen */}
          {loadError && stories.length > 0 && (
            <ErrorState variant="dense" onRetry={handleRetry} />
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

          <div className="px-6 py-8 text-center">
            <p
              data-testid="refresh-footer"
              className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground"
            >
              {footerText}
            </p>
          </div>
        </section>

        {/* Desktop source reader rail (lg+) */}
        {railOpen && (
          <aside className="hidden lg:block">
            <div className="sticky top-16 h-[calc(100vh-4rem)]">
              <SourceReader
                source={activeSource}
                storyTitle={activeSourceStory?.title}
                onClose={() => setActiveSourceId(null)}
                onBack={() => setActiveSourceId(null)}
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
          storyTitle={activeSourceStory?.title}
          onClose={() => setActiveSourceId(null)}
          onBack={() => setActiveSourceId(null)}
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
