import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ArrowRight } from "lucide-react";
import { notifyWarning } from "@/lib/notify";
import { useAuth } from "@/lib/auth";
import {
  trackLandingViewed,
  trackLandingCtaClicked,
  trackLandingFailed,
  trackLandingSucceeded,
} from "@/lib/analytics";
import {
  isValidEmailForLanding,
  classifyEmailValidationFailure,
} from "@/lib/email-validation";

type BackendError = {
  toast: string;
  analyticsKey:
    | "not_enabled"
    | "config_unavailable"
    | "resolve_failed"
    | "invalid_request"
    | "unknown_with_message"
    | "unknown_without_message";
};

const BACKEND_ERROR_MAP: Record<string, BackendError> = {
  "This email is not enabled for the prototype yet. Contact the team to be added.": {
    toast: "Use an invited email to continue.",
    analyticsKey: "not_enabled",
  },
  "resolve-destination requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.": {
    toast: "Try again in a moment.",
    analyticsKey: "config_unavailable",
  },
  "Could not resolve destination.": { toast: "Try again in a moment.", analyticsKey: "resolve_failed" },
  "email is required and must contain @.": { toast: "Enter a valid email to continue.", analyticsKey: "invalid_request" },
};

function resolveBackendError(message?: string): BackendError {
  if (!message) return { toast: "Could not continue. Please try again.", analyticsKey: "unknown_without_message" };
  return BACKEND_ERROR_MAP[message] ?? { toast: "Check your details and try again.", analyticsKey: "unknown_with_message" };
}

export default function EntryLandingPage() {
  const navigate = useNavigate();
  const { setRecognizedIdentity } = useAuth();
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    trackLandingViewed();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = email.trim();

    trackLandingCtaClicked();

    if (!isValidEmailForLanding(trimmed)) {
      const validationReason = classifyEmailValidationFailure(trimmed);
      trackLandingFailed({ failureStage: "validation", validationReason });
      notifyWarning("Enter a valid email to continue.");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/auth/resolve-destination", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimmed }),
      });
      if (!res.ok) {
        const statusCode = res.status;
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        const err = resolveBackendError(body.message);
        trackLandingFailed({ failureStage: "backend", statusCode, mappedErrorKey: err.analyticsKey });
        notifyWarning(err.toast);
        return;
      }
      const data = (await res.json()) as {
        destination: string;
        user: { id: string; email: string } | null;
      };
      if (data.destination === "/dashboard") {
        trackLandingSucceeded("dashboard");
      } else if (data.destination === "/onboarding") {
        trackLandingSucceeded("onboarding");
      } else {
        trackLandingFailed({ failureStage: "backend", mappedErrorKey: "unknown_with_message" });
      }
      // Prefer canonical email from backend (avoids casing/alias mismatch on future requests).
      setRecognizedIdentity({ email: data.user?.email ?? trimmed, userId: data.user?.id ?? null });
      navigate(data.destination);
    } catch {
      trackLandingFailed({ failureStage: "network" });
      notifyWarning("Network error. Please try again.");
    } finally {
      setLoading(false);
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
        <form onSubmit={handleSubmit} noValidate className="fade-up mx-auto w-full max-w-[420px] space-y-3">
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

          <Button type="submit" size="lg" className="w-full gap-2 rounded-sm" disabled={loading}>
            {loading ? "Opening…" : "Stay in sync"}
            <ArrowRight className="h-4 w-4" />
          </Button>

          <p className="pt-1 text-center text-[13px] text-muted-foreground">
            Access is currently invite-only.
          </p>
        </form>
      </div>
    </div>
  );
}
