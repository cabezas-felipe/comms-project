import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Mic, Keyboard, ArrowRight } from "lucide-react";
import { toast } from "sonner";

type Mode = "type" | "voice";

export default function Onboarding() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>("type");
  const [topics, setTopics] = useState("Diplomatic relations, Migration policy, Security cooperation");
  const [keywords, setKeywords] = useState("OFAC, sanctions, deportation routing, bilateral");
  const [geos, setGeos] = useState<string[]>(["US", "Colombia"]);
  const [sources, setSources] = useState("NYT, Washington Post, Reuters, El Tiempo, El País, Semana");

  const toggleGeo = (g: string) =>
    setGeos((prev) => (prev.includes(g) ? prev.filter((x) => x !== g) : [...prev, g]));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!topics.trim() || !geos.length) {
      toast.error("Add at least one topic and one geography to continue.");
      return;
    }
    toast.success("Tempo set. Welcome.");
    setTimeout(() => navigate("/dashboard"), 400);
  };

  return (
    <div className="min-h-screen bg-gradient-paper">
      <div className="mx-auto flex min-h-screen max-w-[720px] flex-col px-6 py-12 lg:py-20">
        {/* Masthead */}
        <div className="mb-12 flex flex-col items-center text-center">
          <span className="font-display text-3xl font-semibold leading-none tracking-tight">
            Tempo
          </span>
          <span className="mt-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            The news, in tempo
          </span>
        </div>

        {/* Hero */}
        <div className="mb-10 text-center">
          <h1 className="font-display text-[40px] font-semibold leading-[1.05] tracking-tight">
            Stop refreshing twelve tabs to find what actually moved.
          </h1>
          <p className="mx-auto mt-4 max-w-[52ch] text-[15px] leading-relaxed text-muted-foreground">
            Tell Tempo what you watch. We cluster, dedupe, and source-check coverage so the news
            arrives in one calm place — however fast it moves.
          </p>
        </div>

        {/* Mode toggle */}
        <div className="mb-8 flex justify-center">
          <div className="inline-flex rounded-sm border border-rule/60 bg-background p-0.5">
            <ModeButton
              active={mode === "type"}
              onClick={() => setMode("type")}
              icon={<Keyboard className="h-3.5 w-3.5" />}
              label="Type"
            />
            <ModeButton
              active={mode === "voice"}
              onClick={() => setMode("voice")}
              icon={<Mic className="h-3.5 w-3.5" />}
              label="Voice"
            />
          </div>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-6">
          {mode === "voice" ? (
            <div className="fade-up rounded-sm border border-rule/60 bg-surface-raised p-6">
              <div className="mb-3 flex items-center justify-between">
                <span className="eyebrow">Example</span>
              </div>
              <p className="font-display text-[17px] leading-[1.6] text-foreground/85">
                &ldquo;Track US and Colombia diplomatic stories — especially OFAC and migration.
                Trust NYT, Reuters, El Tiempo, and Semana.&rdquo;
              </p>
              <div className="mt-5 flex justify-center">
                <button
                  type="button"
                  onClick={() => toast.info("Voice capture is coming. Use Type for now.")}
                  className="inline-flex h-14 w-14 items-center justify-center rounded-full bg-ember text-ember-foreground transition-transform hover:scale-105"
                  aria-label="Record"
                >
                  <Mic className="h-5 w-5" />
                </button>
              </div>
            </div>
          ) : (
            <div className="fade-up rounded-sm border border-rule/60 bg-surface-raised p-6">
              <div className="mb-3 flex items-center justify-between">
                <span className="eyebrow">Example</span>
              </div>
              <Textarea
                value={`Track US and Colombia diplomatic stories — especially OFAC and migration. Trust NYT, Reuters, El Tiempo, and Semana.`}
                onChange={(e) => setTopics(e.target.value)}
                rows={5}
                className="font-display text-[17px] leading-[1.6]"
              />
            </div>
          )}

          {/* Privacy — plain two lines */}
          <div className="border-t border-rule/40 pt-5 text-[13px] leading-relaxed text-muted-foreground">
            <p>
              <span className="font-medium text-foreground">We keep:</span> your scope and source preferences.
            </p>
            <p>
              <span className="font-medium text-foreground">We don&apos;t keep:</span> voice recordings, draft replies, or browsing history.
            </p>
          </div>

          {/* CTA */}
          <div className="flex items-center justify-between pt-2">
            <p className="font-mono text-[11px] text-muted-foreground">
              You can edit anytime in Settings.
            </p>
            <Button type="submit" size="lg" className="gap-2 rounded-sm">
              Set the tempo
              <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ModeButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-sm px-4 py-1.5 text-[13px] font-medium transition-colors ${
        active ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between">
        <Label className="text-[13px] font-medium text-foreground">{label}</Label>
        {hint && (
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            {hint}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}
