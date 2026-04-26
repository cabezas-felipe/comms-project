import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@/lib/auth";

export default function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, loading } = useAuth();
  const location = useLocation();
  const isDevPreview =
    import.meta.env.DEV &&
    new URLSearchParams(location.search).get("preview") === "1";

  if (loading) return null;

  if (isDevPreview) {
    return <>{children}</>;
  }

  if (!isAuthenticated) {
    return <Navigate to="/auth" replace state={{ from: location.pathname }} />;
  }

  return <>{children}</>;
}
