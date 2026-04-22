import { useMemo, useState } from "react";
import { GEOGRAPHIES, Geography, STORIES, Source, Story, TOPICS, Topic, findSource } from "@/data/stories";
import { deriveSignals, keySources, Trend } from "@/lib/derive";
import { timeAgo } from "@/lib/format";
import { ArrowUpRight, ArrowDownRight, Minus, ThumbsUp, ThumbsDown } from "lucide-react";
import SourceReader from "@/components/SourceReader";
import { toast } from "sonner";

type TopicFilter = Topic | "All";
type GeoFilter = Geography | "All";

const TREND: Record<Trend, { icon: typeof ArrowUpRight; label: string; tone: string; bar: string }> = {
  rising: { icon: ArrowUpRight, label: "Rising", tone: "text-ember", bar: "bg-ember" },
  steady: { icon: Minus, label: "Steady", tone: "text-foreground/60", bar: "bg-foreground/70" },
  falling: { icon: ArrowDownRight, label: "Falling", tone: "text-muted-foreground", bar: "bg-muted-foreground/50" },
};

export default function Dashboard() {
  const [topic, setTopic] = useState<TopicFilter>("All");
  const [geo, setGeo] = useState<GeoFilter>("All");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [activeSourceId, setActiveSourceId] = useState<string | null>(null);

  const filtered = useMemo(
    () =>
      STORIES.filter(
        (s) =>
          (topic === "All" || s.topic === topic) &&
          (geo === "All" || s.geographies.includes(geo))
      ).map((s) => ({ story: s, sig: deriveSignals(s) })),
    [topic, geo]
  );

  const counts = useMemo(() => {
    const out = { rising: 0, steady: 0, falling: 0 };
    filtered.forEach(({ sig }) => out[sig.trend]++);
    return out;
  }, [filtered]);

  const headline = useMemo(() => buildHeadline(counts), [counts]);

  const activeSource: Source | null = activeSourceId ? findSource(activeSourceId)?.source ?? null : null;
  const activeSourceStory: Story | null = activeSourceId ? findSource(activeSourceId)?.story ?? null : null;

  const railOpen = !!activeSource;

  return (
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

          {/* Pill row */}
          <div className="mt-5 flex flex-wrap items-center gap-1.5">
            <Pill active={topic === "All" && geo === "All"} onClick={() => { setTopic("All"); setGeo("All"); }}>
              All
            </Pill>
            <span className="mx-1 text-rule">·</span>
            {TOPICS.map((t) => (
              <Pill key={t} active={topic === t} onClick={() => setTopic(topic === t ? "All" : t)}>
                {t}
              </Pill>
            ))}
            <span className="mx-1 text-rule">·</span>
            {GEOGRAPHIES.map((g) => (
              <Pill key={g} active={geo === g} onClick={() => setGeo(geo === g ? "All" : g)}>
                {g}
              </Pill>
            ))}
          </div>
        </div>

        {/* Feed zone */}
        {filtered.length === 0 ? (
          <EmptyState onReset={() => { setTopic("All"); setGeo("All"); }} />
        ) : (
          <ul className="divide-y divide-rule/60">
            {filtered.map(({ story, sig }) => (
              <li key={story.id}>
                <StoryItem
                  story={story}
                  trend={sig.trend}
                  freshestMinutes={sig.freshestMinutes}
                  activityScore={sig.activityScore}
                  expanded={expandedId === story.id}
                  onToggle={() => setExpandedId(expandedId === story.id ? null : story.id)}
                  onOpenSource={(id) => setActiveSourceId(id)}
                />
              </li>
            ))}
          </ul>
        )}

        <div className="px-6 py-8 text-center">
          <p className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
            Next refresh in ~38 min
          </p>
        </div>
      </section>

      {/* On-demand source rail */}
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
  );
}

function buildHeadline(counts: { rising: number; steady: number; falling: number }): string {
  const total = counts.rising + counts.steady + counts.falling;
  if (total === 0) return "Steady tempo across your beat.";
  if (counts.rising === 0 && counts.falling === 0) return "All steady.";
  const parts: string[] = [];
  if (counts.rising > 0) parts.push(`${counts.rising} ${counts.rising === 1 ? "narrative" : "narratives"} rising`);
  if (counts.steady > 0) parts.push(`${counts.steady} steady`);
  if (counts.falling > 0) parts.push(`${counts.falling} falling`);
  return parts.join(" · ");
}

interface ItemProps {
  story: Story;
  trend: Trend;
  freshestMinutes: number;
  activityScore: number;
  expanded: boolean;
  onToggle: () => void;
  onOpenSource: (id: string) => void;
}

function StoryItem({ story, trend, freshestMinutes, activityScore, expanded, onToggle, onOpenSource }: ItemProps) {
  const t = TREND[trend];
  const Icon = t.icon;
  const titleColor = trend === "falling" ? "text-foreground/70" : "text-foreground";
  const sources = keySources(story, 5);

  return (
    <article className={`px-6 py-4 transition-colors ${expanded ? "bg-surface" : "hover:bg-surface/60"}`}>
      <button onClick={onToggle} className="block w-full text-left">
        {/* Status row */}
        <div className="mb-1.5 flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider">
          <span className={`inline-flex items-center gap-1 ${t.tone}`}>
            <Icon className="h-3 w-3" strokeWidth={2.5} />
            <span>{t.label}</span>
          </span>
          <span className="text-rule">·</span>
          <span className="text-muted-foreground">{story.topic}</span>
        </div>

        {/* Compact two-column row: title+takeaway · activity meta */}
        <div className="flex items-start gap-6">
          <div className="min-w-0 flex-1">
            <h2
              className={`font-display text-[19px] font-semibold leading-[1.2] tracking-tight ${titleColor}`}
            >
              {story.title}
            </h2>
            <p className="mt-1 truncate text-[13px] leading-relaxed text-muted-foreground">
              {story.takeaway}
            </p>
          </div>

          {/* Activity meta — Signal Radar style */}
          <div className="hidden shrink-0 items-center gap-3 pt-1 sm:flex">
            <div className="relative h-[2px] w-24 overflow-hidden bg-rule/40">
              <div
                className={`absolute inset-y-0 left-0 ${t.bar}`}
                style={{ width: `${Math.min(100, activityScore)}%` }}
              />
            </div>
            <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
              {timeAgo(freshestMinutes)}
            </span>
            <span className="font-mono text-[11px] text-muted-foreground">
              {story.outletCount} outlets
            </span>
          </div>
        </div>
      </button>

      {/* Expanded inline detail */}
      {expanded && (
        <div className="fade-up mt-4 space-y-4 border-t border-rule/50 pt-4">
          {/* 3-column compact row: Summary · What changed · Why this matters */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <Block label="Summary" body={story.summary} />
            <Block label="What changed" body={story.whatChanged} />
            <div className="rounded-sm border border-ember/30 bg-ember-soft/40 p-3">
              <span className="eyebrow text-ember">Why this matters</span>
              <p className="mt-1 text-[13px] leading-snug text-foreground/90">{story.whyItMatters}</p>
            </div>
          </div>

          {/* Key sources */}
          <div>
            <div className="mb-2 flex items-baseline justify-between">
              <span className="eyebrow">Key sources · {sources.length}</span>
              <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                of {story.outletCount} outlets
              </span>
            </div>
            <ul className="divide-y divide-rule/40 border-y border-rule/40">
              {sources.map((s) => (
                <li key={s.id}>
                  <button
                    onClick={() => onOpenSource(s.id)}
                    className="group flex w-full items-center justify-between py-2 text-left transition-colors hover:bg-background"
                  >
                    <div className="flex items-baseline gap-3">
                      <span aria-hidden className="font-mono text-[11px] text-muted-foreground">
                        {s.kind === "social" ? "◯" : "■"}
                      </span>
                      <span className="font-medium text-foreground">{s.outlet}</span>
                      <span className="font-mono text-[11px] text-muted-foreground">
                        {timeAgo(s.minutesAgo)}
                      </span>
                    </div>
                    <ArrowUpRight className="h-3.5 w-3.5 text-muted-foreground opacity-60 transition-all group-hover:translate-x-0.5 group-hover:text-ember group-hover:opacity-100" />
                  </button>
                </li>
              ))}
            </ul>
          </div>

          {/* Useful */}
          <div className="flex items-center gap-2 border-t border-rule/40 pt-3">
            <span className="eyebrow">Was this useful?</span>
            <button
              onClick={() => toast.success("Marked useful — we'll surface more like this.")}
              aria-label="Useful"
              className="inline-flex items-center justify-center rounded-sm border border-rule/60 p-1.5 text-muted-foreground transition-colors hover:border-foreground hover:text-foreground"
            >
              <ThumbsUp className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => toast.success("Noted — we'll surface fewer like this.")}
              aria-label="Not useful"
              className="inline-flex items-center justify-center rounded-sm border border-rule/60 p-1.5 text-muted-foreground transition-colors hover:border-foreground hover:text-foreground"
            >
              <ThumbsDown className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

function Block({ label, body }: { label: string; body: string }) {
  return (
    <div>
      <span className="eyebrow">{label}</span>
      <p className="mt-1 text-[13px] leading-snug text-foreground/90">{body}</p>
    </div>
  );
}

function Pill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full px-3 py-1 text-[12px] font-medium transition-colors ${
        active ? "bg-foreground text-background" : "text-muted-foreground hover:bg-secondary hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

function EmptyState({ onReset }: { onReset: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-10 py-24 text-center">
      <span className="eyebrow">Empty</span>
      <p className="max-w-[40ch] font-display text-2xl leading-snug">
        Steady tempo. Nothing new across your beat.
      </p>
      <button
        onClick={onReset}
        className="mt-2 text-sm text-ember underline-offset-4 hover:underline"
      >
        Reset filters
      </button>
    </div>
  );
}
