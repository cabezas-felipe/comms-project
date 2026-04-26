import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import { isRateLimitError } from "@/lib/auth-errors";

export default function AuthEmail() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const { signIn } = useAuth();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed || !trimmed.includes("@")) {
      toast.error("Enter a valid email to continue.");
      return;
    }
    setSending(true);
    try {
      await signIn(trimmed);
      navigate(`/auth/check-email?email=${encodeURIComponent(trimmed)}`);
    } catch (err) {
      if (isRateLimitError(err)) {
        if (import.meta.env.DEV) {
          // In local dev only: try the backend fallback that mints a link directly
          // via Supabase Admin API, bypassing email delivery.
          try {
            const res = await fetch("/api/auth/dev-magic-link", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                email: trimmed,
                type: "login",
                redirectTo: `${window.location.origin}/auth/callback`,
              }),
            });
            if (res.ok) {
              const { url } = (await res.json()) as { url: string };
              toast.info("Dev mode: opening magic link directly.");
              window.location.assign(url);
              return; // navigation pending; finally still runs
            }
          } catch {
            // dev fallback failed; fall through to rate-limit message
          }
        }
        toast.error("Too many requests — please wait a minute and try again.");
      } else {
        toast.error("Could not send the magic link. Please try again.");
      }
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-paper">
      <div className="mx-auto flex min-h-screen max-w-[560px] flex-col px-6 py-12 lg:py-20">
        {/* Masthead */}
        <div className="mb-12 flex flex-col items-center text-center">
          <span className="font-display text-3xl font-semibold leading-none tracking-tight">
            Tempo
          </span>
          <span className="mt-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            The news, in tempo
          </span>
        </div>

        {/* Back */}
        <button
          type="button"
          onClick={() => navigate("/")}
          className="mb-6 inline-flex w-fit items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3 w-3" />
          Back
        </button>

        {/* Hero */}
        <div className="mb-8">
          <span className="eyebrow">Sign in to Tempo</span>
          <h1 className="mt-2 font-display text-[32px] font-semibold leading-[1.1] tracking-tight">
            Stay in sync with what changed.
          </h1>
          <p className="mt-3 max-w-[48ch] text-[15px] leading-relaxed text-muted-foreground">
            Enter your email and we&apos;ll send a magic link. New or returning — it works the same
            way.
          </p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="fade-up space-y-4">
          <div className="rounded-sm border border-rule/60 bg-surface-raised p-5">
            <label className="eyebrow mb-2 block">Email</label>
            <Input
              type="email"
              autoFocus
              autoComplete="email"
              placeholder="you@domain.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="h-11 rounded-sm border-rule/60 font-display text-[16px]"
            />
          </div>

          <Button type="submit" size="lg" className="w-full gap-2 rounded-sm" disabled={sending}>
            {sending ? "Sending…" : "Stay in sync"}
            <ArrowRight className="h-4 w-4" />
          </Button>
        </form>
      </div>
    </div>
  );
}
