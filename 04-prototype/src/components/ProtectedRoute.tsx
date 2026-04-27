import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@/lib/auth";

export default function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, loading } = useAuth();
  const location = useLocation();

  if (import.meta.env.DEV) return <>{children}</>;
  if (loading) return null;

  if (!isAuthenticated) {
    return <Navigate to="/auth" replace state={{ from: location.pathname }} />;
  }

  return <>{children}</>;
}
