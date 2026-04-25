import { useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { consumeAuthAttemptId, trackAuthSucceeded } from "@/lib/analytics";

export default function AuthCallback() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { isAuthenticated, loading } = useAuth();
  const type = params.get("type") ?? "login";

  useEffect(() => {
    if (!loading && isAuthenticated) {
      const mode = type === "signup" ? "signup" : "login";
      const attemptId = consumeAuthAttemptId() ?? "missing_attempt_id";
      trackAuthSucceeded(mode, attemptId);
      navigate(type === "signup" ? "/onboarding" : "/dashboard", { replace: true });
    }
  }, [isAuthenticated, loading, navigate, type]);

  return (
    <div className="min-h-screen bg-gradient-paper flex items-center justify-center">
      <p className="font-mono text-sm text-muted-foreground">Signing you in…</p>
    </div>
  );
}
