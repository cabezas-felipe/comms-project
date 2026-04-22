import ArchiveBanner from "@/components/ArchiveBanner";
import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";

const DIRECTIONS = [
  {
    to: "/d/signal-radar",
    num: "01",
    name: "Signal Radar",
    tag: "Minimal · design-forward",
    thesis: "A scan-first surface that ranks narratives by momentum and surfaces only what's moving — speed of recognition over depth.",
    value: "See in 5 seconds which stories are rising right now.",
    layout: "Editorial single-column feed ranked by computed momentum, with a sticky minimal detail rail.",
    emphasis: "Trend glyph + giant headline + thin momentum bar. No tables, no chips, no chrome.",
    interaction: "Click-to-focus; filter pills toggle inline; rising stories tinted ember.",
    tradeoff: "Excellent for triage; weaker when an analyst needs source-level provenance side-by-side.",
  },
  {
    to: "/d/evidence-desk",
    num: "02",
    name: "Evidence Desk",
    tag: "Dense · information-forward",
    thesis: "A high-density ledger of clusters and their sources, optimized for analysts who want to verify what is happening now.",
    value: "Compare outlets, confidence and freshness across every cluster on one screen.",
    layout: "Sortable tabular list with inline expand-to-source-ledger; toolbar filters above.",
    emphasis: "Confidence meter, outlet count, freshest timestamp; expand reveals a per-source table.",
    interaction: "Sort by fresh / outlets / confidence; row expands to a citation-style ledger; per-source open links.",
    tradeoff: "Maximum information density; can feel intimidating on a small viewport and slower to scan emotionally.",
  },
  {
    to: "/d/analyst-briefing",
    num: "03",
    name: "Analyst Briefing",
    tag: "Recommendation · decision-forward",
    thesis: "A daily prepared brief that proposes a posture per cluster and asks the operator to accept or snooze each recommendation.",
    value: "Walk away with a logged decision on every priority story in under 5 minutes.",
    layout: "Cover-page summary of postures, then numbered briefing cards stacked top-to-bottom.",
    emphasis: "Posture badge, recommended next step, three-column rationale, accept/snooze CTAs.",
    interaction: "Accept logs the recommendation (toast + state); snooze fades the card until next refresh.",
    tradeoff: "Best for executives and time-poor operators; can feel prescriptive when the model lacks context.",
  },
];

export default function Directions() {
  return (
    <div className="min-h-[calc(100vh-4rem)] bg-background">
      <ArchiveBanner />
      <header className="border-b border-rule/60 px-10 py-12">
        <div className="mx-auto max-w-[1100px]">
          <span className="eyebrow">Three directions · same data</span>
          <h1 className="mt-2 font-display text-[40px] font-semibold leading-tight tracking-tight">
            Same stories. Three different operating modes.
          </h1>
          <p className="mt-3 max-w-[64ch] text-[15px] leading-relaxed text-muted-foreground">
            Each direction renders the same five clusters and source list, but reorganizes hierarchy and
            interaction around a different primary user value.
          </p>
        </div>
      </header>

      <div className="mx-auto max-w-[1100px] px-10 py-10">
        <div className="grid gap-6 md:grid-cols-3">
          {DIRECTIONS.map((d) => (
            <Link
              key={d.to}
              to={d.to}
              className="group flex flex-col rounded-sm border border-rule/60 bg-surface-raised p-6 transition-all hover:-translate-y-0.5 hover:border-foreground/40 hover:shadow-paper"
            >
              <span className="font-mono text-[11px] tabular-nums text-muted-foreground">{d.num}</span>
              <h2 className="mt-2 font-display text-2xl font-semibold leading-tight">{d.name}</h2>
              <span className="mt-1 font-mono text-[10px] uppercase tracking-wider text-ember">{d.tag}</span>
              <p className="mt-4 text-[14px] leading-relaxed text-foreground/85">{d.thesis}</p>
              <span className="mt-auto inline-flex items-center gap-1 pt-6 text-sm text-foreground group-hover:text-ember">
                Open <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
              </span>
            </Link>
          ))}
        </div>

        {/* Spec table */}
        <section className="mt-14 space-y-10">
          {DIRECTIONS.map((d) => (
            <article key={d.to} className="border-t border-rule/60 pt-8">
              <div className="flex items-baseline justify-between gap-6">
                <div>
                  <span className="font-mono text-[11px] text-muted-foreground">{d.num} · {d.tag}</span>
                  <h3 className="font-display text-3xl font-semibold leading-tight">{d.name}</h3>
                </div>
                <Link to={d.to} className="text-sm text-ember underline-offset-4 hover:underline">
                  View prototype →
                </Link>
              </div>

              <dl className="mt-6 grid gap-x-10 gap-y-5 md:grid-cols-2">
                <Spec label="1 · Design thesis" body={d.thesis} />
                <Spec label="2 · Primary user value" body={d.value} />
                <Spec label="3 · Page structure" body={d.layout} />
                <Spec label="4 · Component emphasis" body={d.emphasis} />
                <Spec label="5 · Key interaction" body={d.interaction} />
                <Spec label="6 · Tradeoff / risk" body={d.tradeoff} />
              </dl>
            </article>
          ))}
        </section>
      </div>
    </div>
  );
}

function Spec({ label, body }: { label: string; body: string }) {
  return (
    <div>
      <dt className="eyebrow">{label}</dt>
      <dd className="mt-1.5 text-[14px] leading-relaxed text-foreground/85">{body}</dd>
    </div>
  );
}
