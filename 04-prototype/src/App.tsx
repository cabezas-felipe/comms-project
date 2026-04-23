import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "./pages/NotFound.tsx";
import Onboarding from "./pages/Onboarding.tsx";
import Dashboard from "./pages/Dashboard.tsx";
import Settings from "./pages/Settings.tsx";
import ArchiveIndex from "./pages/archive/ArchiveIndex.tsx";
import SignalRadar from "./pages/archive/SignalRadar.tsx";
import EvidenceDesk from "./pages/archive/EvidenceDesk.tsx";
import AnalystBriefing from "./pages/archive/AnalystBriefing.tsx";
import AppHeader from "./components/AppHeader.tsx";
import ProtectedRoute from "./components/ProtectedRoute.tsx";
import { AuthProvider } from "./lib/auth.tsx";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <AuthProvider>
        <BrowserRouter>
          <AppHeader />
          <Routes>
            <Route path="/" element={<Navigate to="/onboarding" replace />} />
            <Route path="/onboarding" element={<Onboarding />} />
            <Route
              path="/dashboard"
              element={
                <ProtectedRoute>
                  <Dashboard />
                </ProtectedRoute>
              }
            />
            <Route
              path="/settings"
              element={
                <ProtectedRoute>
                  <Settings />
                </ProtectedRoute>
              }
            />
            <Route
              path="/archive"
              element={
                <ProtectedRoute>
                  <ArchiveIndex />
                </ProtectedRoute>
              }
            />
            <Route
              path="/archive/signal-radar"
              element={
                <ProtectedRoute>
                  <SignalRadar />
                </ProtectedRoute>
              }
            />
            <Route
              path="/archive/evidence-desk"
              element={
                <ProtectedRoute>
                  <EvidenceDesk />
                </ProtectedRoute>
              }
            />
            <Route
              path="/archive/analyst-briefing"
              element={
                <ProtectedRoute>
                  <AnalystBriefing />
                </ProtectedRoute>
              }
            />
            {/* Legacy redirects */}
            <Route path="/d/signal-radar" element={<Navigate to="/archive/signal-radar" replace />} />
            <Route path="/d/evidence-desk" element={<Navigate to="/archive/evidence-desk" replace />} />
            <Route path="/d/analyst-briefing" element={<Navigate to="/archive/analyst-briefing" replace />} />
            <Route path="/directions" element={<Navigate to="/archive" replace />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
