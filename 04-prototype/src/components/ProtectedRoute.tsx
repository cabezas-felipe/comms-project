import { Navigate, useLocation } from "react-router-dom";
import { getProtoSession } from "@/lib/auth";

export default function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const location = useLocation();

  // DEV: allow access without going through the landing flow for local iteration.
  if (import.meta.env.DEV) return <>{children}</>;

  if (!getProtoSession()) {
    return <Navigate to="/" replace state={{ from: location.pathname }} />;
  }

  return <>{children}</>;
}
