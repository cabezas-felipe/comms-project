import { Navigate, useLocation } from "react-router-dom";
import { getProtoSession } from "@/lib/auth";

export default function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const location = useLocation();

  if (!getProtoSession()) {
    return <Navigate to="/" replace state={{ from: location.pathname }} />;
  }

  return <>{children}</>;
}
