import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ArrowRight } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import { isRateLimitError } from "@/lib/auth-errors";
import {
  trackLandingViewed,
  trackAuthCtaClicked,
  trackAuthStarted,
  createAuthAttemptId,
  persistAuthAttemptId,
} from "@/lib/analytics";

export default function EntryLandingPage() {
  const navigate = useNavigate();
  const { signIn } = useAuth();
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    trackLandingViewed();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed || !trimmed.includes("@")) {
      toast.error("Enter a valid email to continue.");
      return;
    }

    const attemptId = createAuthAttemptId();
    persistAuthAttemptId(attemptId);
    trackAuthCtaClicked("login");
    trackAuthStarted("login", attemptId);

    setSending(true);
    try {
      await signIn(trimmed);
      navigate(`/auth?email=${encodeURIComponent(trimmed)}`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (
        import.meta.env.DEV &&
        errMsg.includes("Supabase is not configured")
      ) {
        toast.info(
          "Prototype: skipped sending email — open /auth or configure Supabase for real magic links.",
        );
        navigate(`/auth?email=${encodeURIComponent(trimmed)}`);
        return;
      }
      if (isRateLimitError(err)) {
        if (import.meta.env.DEV) {
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
              return;
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
            Stay on top of what changed while the narrative keeps moving.
          </h1>
          <p className="mx-auto mt-4 max-w-[52ch] text-[15px] leading-relaxed text-muted-foreground">
            Tempo surfaces meaningful shifts across trusted sources so you can monitor, draft, and
            respond without losing focus.
          </p>
        </div>

        {/* Single email entry */}
        <form onSubmit={handleSubmit} className="fade-up mx-auto w-full max-w-[420px] space-y-3">
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

          <p className="pt-1 text-center text-[13px] text-muted-foreground">
            New here? We&apos;ll set you up. Returning? Welcome back.
          </p>
          <p className="pt-1 text-center font-mono text-[11px] text-muted-foreground">
            No password. We&apos;ll send a magic link.
          </p>
        </form>
      </div>
    </div>
  );
}
