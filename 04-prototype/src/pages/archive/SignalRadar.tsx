import { useMemo, useState } from "react";
import { GEOGRAPHIES, Geography, STORIES, TOPICS, Topic } from "@/data/stories";
import { deriveSignals, Trend } from "@/lib/derive";
import { timeAgo } from "@/lib/format";
import { ArrowDownRight, ArrowUpRight, Minus, RefreshCw, X } from "lucide-react";
import { EmptyState, ErrorState, LoadingState } from "@/components/StateBlocks";

type State = "ready" | "loading" | "empty" | "error";

const TREND_GLYPH: Record<Trend, { icon: typeof ArrowUpRight; label: string; tone: string }> = {
  rising: { icon: ArrowUpRight, label: "Rising", tone: "text-ember" },
  steady: { icon: Minus, label: "Steady", tone: "text-foreground/60" },
  falling: { icon: ArrowDownRight, label: "Falling", tone: "text-signal-positive" },
};

import ArchiveBanner from "@/components/ArchiveBanner";

export default function SignalRadar() {
  const [topic, setTopic] = useState<Topic | "All">("All");
  const [geo, setGeo] = useState<Geography | "All">("All");
  const [activeId, setActiveId] = useState<string | null>(STORIES[0].id);
  const [state, setState] = useState<State>("ready");

  const stories = useMemo(
    () =>
      STORIES.filter(
        (s) => (topic === "All" || s.topic === topic) && (geo === "All" || s.geographies.includes(geo))
      ).map((s) => ({ story: s, sig: deriveSignals(s) }))
        .sort((a, b) => b.sig.activityScore - a.sig.activityScore),
    [topic, geo]
  );

  const active = stories.find((x) => x.story.id === activeId) ?? null;
  const maxMomentum = Math.max(...stories.map((x) => x.sig.activityScore), 1);

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-background">
      <ArchiveBanner />
      {/* Radar masthead */}
      <header className="border-b border-rule/60 px-10 py-8">
        <div className="mx-auto flex max-w-[1400px] items-end justify-between gap-8">
          <div>
            <span className="eyebrow text-ember">Signal radar</span>
            <h1 className="mt-1 font-display text-[44px] font-semibold leading-[1.05] tracking-tight">
              {stories.filter((s) => s.sig.trend === "rising").length} narratives rising
            </h1>
            <p className="mt-2 max-w-[52ch] text-sm text-muted-foreground">
              Scan-first view. Stories ranked by activityScore — newest signal × outlet volume.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <DemoToggle state={state} setState={setState} />
            <button
              onClick={() => { setTopic("All"); setGeo("All"); }}
              className="inline-flex items-center gap-1.5 rounded-sm border border-rule/60 px-3 py-1.5 text-xs text-muted-foreground hover:bg-secondary"
            >
              <RefreshCw className="h-3 w-3" /> Reset
            </button>
          </div>
        </div>

        {/* Filter pills — minimal */}
        <div className="mx-auto mt-6 flex max-w-[1400px] flex-wrap items-center gap-2">
          <Pill active={topic === "All" && geo === "All"} onClick={() => { setTopic("All"); setGeo("All"); }}>
            All signal
          </Pill>
          <span className="text-rule">·</span>
          {TOPICS.map((t) => (
            <Pill key={t} active={topic === t} onClick={() => setTopic(topic === t ? "All" : t)}>
              {t}
            </Pill>
          ))}
          <span className="text-rule">·</span>
          {GEOGRAPHIES.map((g) => (
            <Pill key={g} active={geo === g} onClick={() => setGeo(geo === g ? "All" : g)}>
              {g}
            </Pill>
          ))}
        </div>
      </header>

      {/* Body */}
      <div className="mx-auto grid max-w-[1400px] grid-cols-1 lg:grid-cols-[minmax(0,1fr)_420px]">
        <section className="border-r border-rule/60">
          {state === "loading" && <LoadingState variant="minimal" />}
          {state === "error" && <ErrorState variant="minimal" onRetry={() => setState("ready")} />}
          {state === "empty" && <EmptyState variant="minimal" onRetry={() => setState("ready")} />}
          {state === "ready" && stories.length === 0 && (
            <EmptyState variant="minimal" onRetry={() => { setTopic("All"); setGeo("All"); }} />
          )}
          {state === "ready" && stories.length > 0 && (
            <ul>
              {stories.map(({ story, sig }) => {
                const Trend = TREND_GLYPH[sig.trend];
                const Icon = Trend.icon;
                const isActive = story.id === activeId;
                return (
                  <li key={story.id}>
                    <button
                      onClick={() => setActiveId(story.id)}
                      className={`group block w-full px-10 py-7 text-left transition-colors ${
                        isActive ? "bg-surface" : "hover:bg-surface/60"
                      }`}
                    >
                      {/* Top row: trend + topic + freshness */}
                      <div className="mb-3 flex items-center gap-3">
                        <span className={`inline-flex items-center gap-1 ${Trend.tone}`}>
                          <Icon className="h-3.5 w-3.5" strokeWidth={2.5} />
                          <span className="font-mono text-[10px] uppercase tracking-wider">
                            {Trend.label}
                          </span>
                        </span>
                        <span className="text-rule">·</span>
                        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                          {story.topic}
                        </span>
                        <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                          {timeAgo(sig.freshestMinutes)}
                        </span>
                      </div>

                      {/* Big editorial title */}
                      <h2 className="font-display text-[28px] font-semibold leading-[1.1] tracking-tight text-foreground">
                        {story.title}
                      </h2>

                      {/* Momentum bar */}
                      <div className="mt-5 flex items-center gap-4">
                        <div className="flex-1">
                          <div className="relative h-[3px] w-full overflow-hidden bg-rule/40">
                            <div
                              className="absolute inset-y-0 left-0 bg-foreground transition-all"
                              style={{ width: `${(sig.activityScore / maxMomentum) * 100}%` }}
                            />
                            {sig.trend === "rising" && (
                              <div
                                className="absolute inset-y-0 left-0 bg-ember"
                                style={{ width: `${(sig.activityScore / maxMomentum) * 100}%` }}
                              />
                            )}
                          </div>
                        </div>
                        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                          {sig.activityScore}
                        </span>
                        <span className="font-mono text-[11px] text-muted-foreground">
                          {story.outletCount} outlets
                        </span>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* Right: minimal detail */}
        <aside className="hidden lg:block">
          <div className="sticky top-16 h-[calc(100vh-4rem)] overflow-y-auto px-8 py-8">
            {active ? (
              <div className="fade-up space-y-7">
                <div className="flex items-start justify-between gap-3">
                  <span className="eyebrow text-ember">{TREND_GLYPH[active.sig.trend].label} · {active.story.topic}</span>
                  <button onClick={() => setActiveId(null)} className="text-muted-foreground hover:text-foreground">
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <h3 className="font-display text-2xl font-semibold leading-tight">{active.story.title}</h3>

                <div className="grid grid-cols-3 gap-4 border-y border-rule/50 py-5">
                  <Stat label="Momentum" value={active.sig.activityScore} suffix="" />
                  <Stat label="Freshest" value={active.sig.freshestMinutes} suffix="m" />
                  <Stat label="Outlets" value={active.story.outletCount} suffix="" />
                </div>

                <div>
                  <span className="eyebrow">What shifted</span>
                  <p className="mt-1.5 text-[15px] leading-relaxed">{active.story.whatChanged}</p>
                </div>

                <div className="border-t border-rule/50 pt-5">
                  <span className="eyebrow">Latest sources</span>
                  <ul className="mt-2 space-y-1.5">
                    {active.story.sources.slice(0, 4).map((s) => (
                      <li key={s.outlet} className="flex items-baseline justify-between text-sm">
                        <span>{s.outlet}</span>
                        <span className="font-mono text-[11px] text-muted-foreground">{timeAgo(s.minutesAgo)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            ) : (
              <div className="flex h-full items-center justify-center text-center">
                <p className="max-w-[24ch] font-display text-xl text-muted-foreground">
                  Pick a signal to expand it.
                </p>
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

function Pill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
        active ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

function Stat({ label, value, suffix }: { label: string; value: number; suffix: string }) {
  return (
    <div>
      <div className="eyebrow">{label}</div>
      <div className="mt-1 font-display text-2xl font-semibold tabular-nums">
        {value}
        <span className="ml-0.5 text-sm text-muted-foreground">{suffix}</span>
      </div>
    </div>
  );
}

function DemoToggle({ state, setState }: { state: State; setState: (s: State) => void }) {
  return (
    <select
      value={state}
      onChange={(e) => setState(e.target.value as State)}
      className="rounded-sm border border-rule/60 bg-background px-2 py-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground"
    >
      <option value="ready">state · ready</option>
      <option value="loading">state · loading</option>
      <option value="empty">state · empty</option>
      <option value="error">state · error</option>
    </select>
  );
}
