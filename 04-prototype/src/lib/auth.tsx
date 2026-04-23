import { createContext, useContext, useMemo, useState } from "react";

const AUTH_STORAGE_KEY = "tempo.auth.session.v1";

interface AuthContextValue {
  isAuthenticated: boolean;
  login: () => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(() => {
    return localStorage.getItem(AUTH_STORAGE_KEY) === "1";
  });

  const value = useMemo<AuthContextValue>(
    () => ({
      isAuthenticated,
      login: () => {
        localStorage.setItem(AUTH_STORAGE_KEY, "1");
        setIsAuthenticated(true);
      },
      logout: () => {
        localStorage.removeItem(AUTH_STORAGE_KEY);
        setIsAuthenticated(false);
      },
    }),
    [isAuthenticated]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return value;
}
