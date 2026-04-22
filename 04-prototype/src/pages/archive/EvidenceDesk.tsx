import ArchiveBanner from "@/components/ArchiveBanner";
import { useMemo, useState } from "react";
import { GEOGRAPHIES, Geography, STORIES, TOPICS, Topic } from "@/data/stories";
import { deriveSignals } from "@/lib/derive";
import { timeAgo } from "@/lib/format";
import { ArrowUpRight, Filter } from "lucide-react";
import { EmptyState, ErrorState, LoadingState } from "@/components/StateBlocks";

type State = "ready" | "loading" | "empty" | "error";
type SortKey = "fresh" | "outlets" | "confidence";

export default function EvidenceDesk() {
  const [topic, setTopic] = useState<Topic | "All">("All");
  const [geo, setGeo] = useState<Geography | "All">("All");
  const [sort, setSort] = useState<SortKey>("fresh");
  const [openId, setOpenId] = useState<string | null>(STORIES[0].id);
  const [state, setState] = useState<State>("ready");

  const rows = useMemo(() => {
    const base = STORIES.filter(
      (s) => (topic === "All" || s.topic === topic) && (geo === "All" || s.geographies.includes(geo))
    ).map((s) => ({ story: s, sig: deriveSignals(s) }));
    return base.sort((a, b) => {
      if (sort === "fresh") return a.sig.freshestMinutes - b.sig.freshestMinutes;
      if (sort === "outlets") return b.story.outletCount - a.story.outletCount;
      return b.sig.confidenceScore - a.sig.confidenceScore;
    });
  }, [topic, geo, sort]);

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-surface">
      <ArchiveBanner />
      {/* Toolbar */}
      <div className="border-b border-rule/60 bg-surface-raised">
        <div className="mx-auto flex max-w-[1600px] items-center justify-between gap-6 px-6 py-3">
          <div className="flex items-center gap-4">
            <h1 className="font-display text-xl font-semibold">Evidence desk</h1>
            <span className="font-mono text-[11px] text-muted-foreground">
              {rows.length} clusters · {rows.reduce((n, r) => n + r.story.sources.length, 0)} sources
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Select value={topic} onChange={(v) => setTopic(v as any)} options={["All", ...TOPICS]} label="Topic" />
            <Select value={geo} onChange={(v) => setGeo(v as any)} options={["All", ...GEOGRAPHIES]} label="Geo" />
            <Select
              value={sort}
              onChange={(v) => setSort(v as SortKey)}
              options={["fresh", "outlets", "confidence"]}
              label="Sort"
            />
            <DemoToggle state={state} setState={setState} />
          </div>
        </div>

        {/* Column headers */}
        <div className="grid grid-cols-[80px_minmax(0,1fr)_120px_140px_120px_40px] border-t border-rule/60 bg-surface px-6 py-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          <span>Topic</span>
          <span>Cluster · sources</span>
          <span>Outlets</span>
          <span>Confidence</span>
          <span>Freshest</span>
          <span></span>
        </div>
      </div>

      {state === "loading" && <LoadingState variant="dense" />}
      {state === "error" && <ErrorState variant="dense" onRetry={() => setState("ready")} />}
      {state === "empty" && <EmptyState variant="dense" onRetry={() => setState("ready")} />}
      {state === "ready" && rows.length === 0 && (
        <EmptyState variant="dense" onRetry={() => { setTopic("All"); setGeo("All"); }} />
      )}

      {state === "ready" && rows.length > 0 && (
        <div className="divide-y divide-rule/50 border-b border-rule/60 bg-surface-raised">
          {rows.map(({ story, sig }) => {
            const open = story.id === openId;
            return (
              <article key={story.id}>
                <button
                  onClick={() => setOpenId(open ? null : story.id)}
                  className={`grid w-full grid-cols-[80px_minmax(0,1fr)_120px_140px_120px_40px] items-start gap-x-4 px-6 py-4 text-left transition-colors hover:bg-surface ${
                    open ? "bg-surface" : ""
                  }`}
                >
                  <span className="mt-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                    {story.topic.split(" ")[0]}
                  </span>
                  <div className="min-w-0">
                    <div className="flex items-baseline gap-2">
                      {story.priority === "top" && (
                        <span className="rounded-sm bg-ember px-1 py-0.5 font-mono text-[9px] uppercase tracking-wider text-ember-foreground">
                          Priority
                        </span>
                      )}
                      <h3 className="truncate font-display text-[17px] font-semibold leading-tight text-foreground">
                        {story.title}
                      </h3>
                    </div>
                    <p className="mt-1 line-clamp-1 text-[13px] text-muted-foreground">{story.summary}</p>
                  </div>
                  <span className="mt-0.5 font-mono text-sm tabular-nums">{story.outletCount}</span>
                  <div className="mt-0.5">
                    <ConfidenceMeter score={sig.confidenceScore} label={sig.confidence} />
                  </div>
                  <span className="mt-0.5 font-mono text-[12px] tabular-nums text-muted-foreground">
                    {timeAgo(sig.freshestMinutes)}
                  </span>
                  <span className="mt-0.5 text-right text-muted-foreground">
                    {open ? "−" : "+"}
                  </span>
                </button>

                {open && (
                  <div className="grid grid-cols-[80px_minmax(0,1fr)_120px_140px_120px_40px] gap-x-4 border-t border-rule/40 bg-background px-6 py-5">
                    <div />
                    <div className="col-span-4 grid grid-cols-2 gap-x-10 gap-y-5">
                      <div>
                        <span className="eyebrow">Summary</span>
                        <p className="mt-1.5 text-[14px] leading-relaxed">{story.summary}</p>
                      </div>
                      <div>
                        <span className="eyebrow">What changed</span>
                        <p className="mt-1.5 text-[14px] leading-relaxed">{story.whatChanged}</p>
                      </div>

                      {/* Source ledger */}
                      <div className="col-span-2">
                        <div className="mb-2 flex items-center justify-between">
                          <span className="eyebrow">Source ledger · {story.sources.length}</span>
                          <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                            outlet diversity {sig.outletDiversity}
                          </span>
                        </div>
                        <table className="w-full border-y border-rule/50 font-mono text-[12px]">
                          <thead className="text-[10px] uppercase tracking-wider text-muted-foreground">
                            <tr className="border-b border-rule/40">
                              <th className="py-1.5 text-left font-medium">Outlet</th>
                              <th className="py-1.5 text-left font-medium">Geo</th>
                              <th className="py-1.5 text-right font-medium">Published</th>
                              <th className="py-1.5 text-right font-medium">Open</th>
                            </tr>
                          </thead>
                          <tbody>
                            {story.sources.map((s) => (
                              <tr key={s.outlet} className="border-b border-rule/30 last:border-0">
                                <td className="py-2 font-sans text-[13px] font-medium text-foreground">{s.outlet}</td>
                                <td className="py-2 text-muted-foreground">
                                  {story.geographies.map((g) => (g === "US" ? "US" : "CO")).join(" · ")}
                                </td>
                                <td className="py-2 text-right tabular-nums text-muted-foreground">
                                  {timeAgo(s.minutesAgo)}
                                </td>
                                <td className="py-2 text-right">
                                  <a href={s.url} className="inline-flex items-center text-foreground hover:text-ember">
                                    <ArrowUpRight className="h-3.5 w-3.5" />
                                  </a>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                    <div />
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ConfidenceMeter({ score, label }: { score: number; label: string }) {
  const segs = 5;
  const filled = Math.round((score / 100) * segs);
  return (
    <div className="flex items-center gap-2">
      <div className="flex gap-[2px]">
        {Array.from({ length: segs }).map((_, i) => (
          <span
            key={i}
            className={`h-2 w-1.5 ${i < filled ? "bg-foreground" : "bg-rule/50"}`}
          />
        ))}
      </div>
      <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
    </div>
  );
}

function Select({
  value,
  onChange,
  options,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  label: string;
}) {
  return (
    <label className="inline-flex items-center gap-1.5 rounded-sm border border-rule/60 bg-background px-2 py-1">
      <Filter className="h-3 w-3 text-muted-foreground" />
      <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-transparent text-xs focus:outline-none"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
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
