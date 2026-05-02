import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "./supabase";

// ─── Prototype session marker ─────────────────────────────────────────────────
// Lightweight identity hint set after /api/auth/resolve-destination resolves.
// Not a real auth token — exists only so ProtectedRoute and AppHeader can gate
// on "user went through the landing flow" without a Supabase session.

export type ProtoSession = { email: string; userId: string | null };

const PROTO_SESSION_KEY = "tempo_proto_session";

export function getProtoSession(): ProtoSession | null {
  try {
    const raw = localStorage.getItem(PROTO_SESSION_KEY);
    return raw ? (JSON.parse(raw) as ProtoSession) : null;
  } catch {
    return null;
  }
}

export function setProtoSession(session: ProtoSession): void {
  try {
    localStorage.setItem(PROTO_SESSION_KEY, JSON.stringify(session));
  } catch { /* storage blocked */ }
}

function clearProtoSession(): void {
  try {
    localStorage.removeItem(PROTO_SESSION_KEY);
  } catch { /* storage blocked */ }
}

interface AuthContextValue {
  isAuthenticated: boolean;
  user: User | null;
  session: Session | null;
  loading: boolean;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      setLoading(false);
    });

    return () => subscription.unsubscribe();
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      isAuthenticated: !!session,
      user: session?.user ?? null,
      session,
      loading,
      logout: async () => {
        clearProtoSession();
        try {
          await supabase.auth.signOut();
        } catch {
          // signOut failed (e.g. offline); local state already cleared above
        }
      },
    }),
    [session, loading]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used within an AuthProvider");
  return value;
}
