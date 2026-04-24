import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";

type Mode = "login" | "signup";

export default function AuthEmail() {
  const navigate = useNavigate();
  const { mode } = useParams<{ mode: Mode }>();
  const isSignup = mode === "signup";
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const { signIn } = useAuth();

  const copy = isSignup
    ? {
        eyebrow: "Create your account",
        title: "Start your tempo.",
        sub: "Enter your email — we'll send a magic link to set things up.",
        cta: "Send magic link",
        switchPrompt: "Already have an account?",
        switchAction: "Log in",
        switchTo: "/auth/login",
      }
    : {
        eyebrow: "Welcome back",
        title: "Pick up where you left off.",
        sub: "Enter your email — we'll send a magic link to sign you in.",
        cta: "Send magic link",
        switchPrompt: "New to Tempo?",
        switchAction: "Sign up",
        switchTo: "/auth/signup",
      };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed || !trimmed.includes("@")) {
      toast.error("Enter a valid email to continue.");
      return;
    }
    setSending(true);
    try {
      await signIn(trimmed, isSignup ? "signup" : "login");
      navigate(
        `/auth/check-email?mode=${isSignup ? "signup" : "login"}&email=${encodeURIComponent(trimmed)}`
      );
    } catch {
      toast.error("Could not send the magic link. Please try again.");
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
          <span className="eyebrow">{copy.eyebrow}</span>
          <h1 className="mt-2 font-display text-[32px] font-semibold leading-[1.1] tracking-tight">
            {copy.title}
          </h1>
          <p className="mt-3 max-w-[48ch] text-[15px] leading-relaxed text-muted-foreground">
            {copy.sub}
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
            {sending ? "Sending…" : copy.cta}
            <ArrowRight className="h-4 w-4" />
          </Button>

          <p className="pt-1 text-center text-[13px] text-muted-foreground">
            {copy.switchPrompt}{" "}
            <button
              type="button"
              onClick={() => navigate(copy.switchTo)}
              className="font-medium text-foreground underline-offset-4 hover:underline"
            >
              {copy.switchAction}
            </button>
          </p>
        </form>
      </div>
    </div>
  );
}
