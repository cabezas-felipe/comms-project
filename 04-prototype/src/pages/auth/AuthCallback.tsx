import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { consumeAuthAttemptId, trackAuthSucceeded } from "@/lib/analytics";

export default function AuthCallback() {
  const navigate = useNavigate();
  const { isAuthenticated, loading, session } = useAuth();

  useEffect(() => {
    if (loading || !isAuthenticated || !session) return;

    const token = session.access_token;
    const attemptId = consumeAuthAttemptId() ?? "missing_attempt_id";

    fetch("/api/auth/post-login-route", {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => (res.ok ? res.json() : Promise.reject(res.status)))
      .then(({ destination }: { destination: string }) => {
        const mode = destination === "/onboarding" ? "signup" : "login";
        trackAuthSucceeded(mode, attemptId);
        navigate(destination, { replace: true });
      })
      .catch(() => {
        trackAuthSucceeded("login", attemptId);
        navigate("/dashboard", { replace: true });
      });
  }, [isAuthenticated, loading, session, navigate]);

  return (
    <div className="min-h-screen bg-gradient-paper flex items-center justify-center">
      <p className="font-mono text-sm text-muted-foreground">Signing you in…</p>
    </div>
  );
}
