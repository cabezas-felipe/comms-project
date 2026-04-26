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
  const [scope, setScope] = useState("");
  const [geos, setGeos] = useState<string[]>(["US", "Colombia"]);

  const EXAMPLE =
    "Track US and Colombia diplomatic stories — especially OFAC and migration. Trust NYT, Reuters, El Tiempo, and Semana.";

  const toggleGeo = (g: string) =>
    setGeos((prev) => (prev.includes(g) ? prev.filter((x) => x !== g) : [...prev, g]));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!scope.trim() || !geos.length) {
      toast.error("Tell us what you're watching to continue.");
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

        {/* Hero — orientation, not persuasion */}
        <div className="mb-10 text-center">
          <h1 className="font-display text-[34px] font-semibold leading-[1.08] tracking-tight sm:text-[40px] sm:leading-[1.05]">
            Tell us what you&apos;re watching.
          </h1>
          <p className="mx-auto mt-4 max-w-[52ch] text-[15px] leading-relaxed text-muted-foreground">
            A few words is enough — topics, regions, sources you trust. You can refine anything
            later in Settings.
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
              <span className="eyebrow mb-3 block">Try something like</span>
              <p className="text-[15px] font-normal italic leading-[1.65] text-muted-foreground/70">
                {EXAMPLE}
              </p>
              <div className="mt-6 flex justify-center">
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
              <span className="eyebrow mb-3 block">Try something like</span>
              <Textarea
                value={scope}
                onChange={(e) => setScope(e.target.value)}
                placeholder={EXAMPLE}
                rows={5}
                className="rounded-sm border-rule/60 text-[15px] font-normal leading-[1.65] not-italic placeholder:italic placeholder:text-muted-foreground/70"
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
          <div className="flex justify-end pt-2">
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
