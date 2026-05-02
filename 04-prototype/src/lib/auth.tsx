import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "./supabase";

// ─── Prototype recognized-identity layer ─────────────────────────────────────
// A lightweight, non-production identity hint set when /api/auth/resolve-destination
// confirms an email is recognized. Not a real auth token — it gates ProtectedRoute
// and AppHeader on "user completed the landing flow" without requiring a Supabase session.
// This is explicitly a prototype identity mechanism, not authentication.

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
  // Prototype recognized identity — single source of truth across the app.
  recognizedIdentity: ProtoSession | null;
  setRecognizedIdentity: (s: ProtoSession) => void;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  // Initialize synchronously from localStorage so ProtectedRoute never flashes a redirect.
  const [protoSession, setProtoSessionState] = useState<ProtoSession | null>(() => getProtoSession());

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
      isAuthenticated: !!session || !!protoSession,
      user: session?.user ?? null,
      session,
      loading,
      recognizedIdentity: protoSession,
      setRecognizedIdentity: (s: ProtoSession) => {
        setProtoSession(s);       // persist to localStorage
        setProtoSessionState(s);  // update React state (triggers re-render)
      },
      logout: async () => {
        clearProtoSession();
        setProtoSessionState(null);
        try {
          await supabase.auth.signOut();
        } catch {
          // signOut failed (e.g. offline); local state already cleared above
        }
      },
    }),
    [session, loading, protoSession]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used within an AuthProvider");
  return value;
}
