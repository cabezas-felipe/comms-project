import { Story } from "@/data/stories";
import { DerivedSignals, keySources, Trend } from "@/lib/derive";
import { timeAgo } from "@/lib/format";
import { ArrowUpRight, ArrowDownRight, Minus } from "lucide-react";

const TREND_STYLE: Record<
  Trend,
  { icon: typeof ArrowUpRight; label: string; tone: string; bar: string }
> = {
  rising:  { icon: ArrowUpRight,   label: "Rising",  tone: "text-ember",            bar: "bg-ember" },
  steady:  { icon: Minus,          label: "Steady",  tone: "text-foreground/60",    bar: "bg-foreground/70" },
  falling: { icon: ArrowDownRight, label: "Falling", tone: "text-muted-foreground", bar: "bg-muted-foreground/50" },
};

interface Props {
  story: Story;
  sig: DerivedSignals;
  expanded: boolean;
  onToggle: () => void;
  onOpenSource: (sourceId: string) => void;
}

export default function StoryCard({ story, sig, expanded, onToggle, onOpenSource }: Props) {
  const t = TREND_STYLE[sig.trend];
  const TrendIcon = t.icon;
  const titleColor = sig.trend === "falling" ? "text-foreground/70" : "text-foreground";
  const sources = keySources(story, 5);

  return (
    <article className={`px-6 py-4 transition-colors ${expanded ? "bg-surface" : "hover:bg-surface/60"}`}>
      {/* Collapsed toggle button — spans the compact row */}
      <button onClick={onToggle} className="block w-full text-left">
        {/* Status row: trend · topic */}
        <div className="mb-1.5 flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider">
          <span className={`inline-flex items-center gap-1 ${t.tone}`}>
            <TrendIcon className="h-3 w-3" strokeWidth={2.5} />
            <span>{t.label}</span>
          </span>
          <span className="text-rule">·</span>
          <span className="text-muted-foreground">{story.topic}</span>
        </div>

        {/* Two-column: headline + takeaway · activity meta */}
        <div className="flex items-start gap-6">
          <div className="min-w-0 flex-1">
            <h2 className={`font-display text-[19px] font-semibold leading-[1.2] tracking-tight ${titleColor}`}>
              {story.title}
            </h2>
            <p className="mt-1 truncate text-[13px] leading-relaxed text-muted-foreground">
              {story.takeaway}
            </p>
          </div>

          {/* Activity bar + freshest time + outlet count */}
          <div className="hidden shrink-0 items-center gap-3 pt-1 sm:flex">
            <div className="relative h-[2px] w-24 overflow-hidden bg-rule/40">
              <div
                className={`absolute inset-y-0 left-0 ${t.bar}`}
                style={{ width: `${Math.min(100, sig.activityScore)}%` }}
              />
            </div>
            <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
              {timeAgo(sig.freshestMinutes)}
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
          {/* 3-column: Summary · What changed · Why this matters */}
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
