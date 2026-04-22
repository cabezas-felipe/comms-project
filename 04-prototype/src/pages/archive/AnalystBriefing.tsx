import ArchiveBanner from "@/components/ArchiveBanner";
import { useMemo, useState } from "react";
import { STORIES } from "@/data/stories";
import { deriveSignals } from "@/lib/derive";
import { timeAgo } from "@/lib/format";
import { Check, ChevronRight, Clock } from "lucide-react";
import { EmptyState, ErrorState, LoadingState } from "@/components/StateBlocks";
import { toast } from "sonner";

type State = "ready" | "loading" | "empty" | "error";

const POSTURE_TONE: Record<string, string> = {
  "Prepare statement": "bg-ember text-ember-foreground",
  "Brief leadership": "bg-foreground text-background",
  "Monitor": "bg-secondary text-secondary-foreground",
  "Hold": "bg-muted text-muted-foreground",
};

export default function AnalystBriefing() {
  const [state, setState] = useState<State>("ready");
  const [acted, setActed] = useState<Record<string, "accept" | "snooze" | undefined>>({});

  const briefings = useMemo(
    () =>
      STORIES.map((s) => ({ story: s, sig: deriveSignals(s) })).sort((a, b) => {
        // priority + activityScore
        const pa = a.story.priority === "top" ? 1 : 0;
        const pb = b.story.priority === "top" ? 1 : 0;
        if (pa !== pb) return pb - pa;
        return b.sig.activityScore - a.sig.activityScore;
      }),
    []
  );

  const requiresAction = briefings.filter(
    (b) => (b.story.priority === "top" || b.sig.activityScore >= 60) && acted[b.story.id] !== "accept"
  ).length;

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-background">
      <ArchiveBanner />
      {/* Cover page */}
      <header className="border-b border-rule/60 bg-gradient-to-b from-surface to-background">
        <div className="mx-auto max-w-[1100px] px-10 py-12">
          <div className="flex items-baseline justify-between">
            <span className="eyebrow">Daily briefing · {new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</span>
            <DemoToggle state={state} setState={setState} />
          </div>
          <h1 className="mt-3 font-display text-[44px] font-semibold leading-[1.05] tracking-tight">
            {requiresAction} {requiresAction === 1 ? "item requires" : "items require"} your decision today.
          </h1>
          <p className="mt-3 max-w-[64ch] text-[15px] leading-relaxed text-muted-foreground">
            Recommendations are derived from outlet volume, freshness, and topic posture. Accept to log the
            decision; snooze to revisit at the next refresh.
          </p>

          <div className="mt-8 grid grid-cols-3 gap-6 border-t border-rule/50 pt-6">
            <Counter label="Prepare statement" value={briefings.filter((b) => b.sig.posture === "Prepare statement").length} />
            <Counter label="Brief leadership" value={briefings.filter((b) => b.sig.posture === "Brief leadership").length} />
            <Counter label="Monitor / Hold" value={briefings.filter((b) => b.sig.posture === "Monitor" || b.sig.posture === "Hold").length} />
          </div>
        </div>
      </header>

      {/* Briefings */}
      <main className="mx-auto max-w-[1100px] px-10 py-10">
        {state === "loading" && <LoadingState variant="briefing" />}
        {state === "error" && <ErrorState variant="briefing" onRetry={() => setState("ready")} />}
        {state === "empty" && <EmptyState variant="briefing" onRetry={() => setState("ready")} />}

        {state === "ready" && (
          <ol className="space-y-8">
            {briefings.map(({ story, sig }, i) => {
              const action = acted[story.id];
              return (
                <li
                  key={story.id}
                  className={`rounded-sm border bg-surface-raised p-7 transition-opacity ${
                    action === "snooze" ? "border-rule/40 opacity-60" : "border-rule/60"
                  }`}
                >
                  <div className="flex items-start justify-between gap-6">
                    <div className="flex-1">
                      <div className="mb-2 flex items-center gap-3">
                        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                          0{i + 1}
                        </span>
                        <span
                          className={`rounded-sm px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${POSTURE_TONE[sig.posture]}`}
                        >
                          {sig.posture}
                        </span>
                        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                          {story.topic} · {story.geographies.join("/")}
                        </span>
                      </div>
                      <h2 className="font-display text-[26px] font-semibold leading-[1.15] tracking-tight">
                        {story.title}
                      </h2>
                    </div>
                    <div className="flex flex-col items-end text-right">
                      <span className="eyebrow">Confidence</span>
                      <span className="font-display text-2xl font-semibold tabular-nums">
                        {sig.confidenceScore}
                        <span className="ml-0.5 text-sm text-muted-foreground">/100</span>
                      </span>
                    </div>
                  </div>

                  {/* Recommendation block */}
                  <div className="mt-5 grid grid-cols-[3px_1fr] gap-4">
                    <div className="bg-ember" />
                    <div>
                      <span className="eyebrow text-ember">Recommended next step</span>
                      <p className="mt-1.5 font-display text-lg leading-snug">{sig.recommendedAction}</p>
                    </div>
                  </div>

                  {/* Rationale */}
                  <div className="mt-6 grid grid-cols-3 gap-6 border-t border-rule/50 pt-5 text-sm">
                    <Rationale label="Why this matters" body={story.whyItMatters} />
                    <Rationale label="What changed" body={story.whatChanged} />
                    <Rationale
                      label="Evidence"
                      body={`${story.outletCount} outlets · ${story.sources.length} cited · freshest ${timeAgo(sig.freshestMinutes)}`}
                    />
                  </div>

                  {/* Action footer */}
                  <div className="mt-6 flex items-center justify-between gap-4 border-t border-rule/50 pt-4">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Clock className="h-3.5 w-3.5" />
                      <span className="font-mono">Next review · {timeAgo(sig.medianMinutes)}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      {action === "accept" ? (
                        <span className="inline-flex items-center gap-1.5 rounded-sm bg-signal-positive/15 px-3 py-1.5 text-xs text-signal-positive">
                          <Check className="h-3.5 w-3.5" /> Accepted
                        </span>
                      ) : (
                        <>
                          <button
                            onClick={() => {
                              setActed((a) => ({ ...a, [story.id]: "snooze" }));
                              toast.success("Snoozed to next refresh.");
                            }}
                            className="rounded-sm border border-rule/60 px-3 py-1.5 text-xs hover:bg-secondary"
                          >
                            Snooze
                          </button>
                          <button
                            onClick={() => {
                              setActed((a) => ({ ...a, [story.id]: "accept" }));
                              toast.success("Recommendation accepted — logged to decision trail.");
                            }}
                            className="inline-flex items-center gap-1.5 rounded-sm bg-foreground px-3 py-1.5 text-xs text-background hover:bg-foreground/90"
                          >
                            Accept <ChevronRight className="h-3.5 w-3.5" />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </main>
    </div>
  );
}

function Counter({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <span className="eyebrow">{label}</span>
      <div className="mt-1 font-display text-3xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function Rationale({ label, body }: { label: string; body: string }) {
  return (
    <div>
      <span className="eyebrow">{label}</span>
      <p className="mt-1.5 leading-relaxed text-foreground/85">{body}</p>
    </div>
  );
}

function DemoToggle({ state, setState }: { state: State; setState: (s: State) => void }) {
  return (
    <select
      value={state}
      onChange={(e) => setState(e.target.value as State)}
      className="rounded-sm border border-rule/60 bg-background px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground"
    >
      <option value="ready">ready</option>
      <option value="loading">loading</option>
      <option value="empty">empty</option>
      <option value="error">error</option>
    </select>
  );
}
