import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "./pages/NotFound.tsx";
import Landing from "./pages/Landing.tsx";
import AuthEmail from "./pages/auth/AuthEmail.tsx";
import CheckEmail from "./pages/auth/CheckEmail.tsx";
import Onboarding from "./pages/Onboarding.tsx";
import Dashboard from "./pages/Dashboard.tsx";
import Settings from "./pages/Settings.tsx";
import ArchiveIndex from "./pages/archive/ArchiveIndex.tsx";
import SignalRadar from "./pages/archive/SignalRadar.tsx";
import EvidenceDesk from "./pages/archive/EvidenceDesk.tsx";
import AnalystBriefing from "./pages/archive/AnalystBriefing.tsx";
import AppHeader from "./components/AppHeader.tsx";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <AppHeader />
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/auth/:mode" element={<AuthEmail />} />
          <Route path="/auth/check-email" element={<CheckEmail />} />
          <Route path="/onboarding" element={<Onboarding />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/archive" element={<ArchiveIndex />} />
          <Route path="/archive/signal-radar" element={<SignalRadar />} />
          <Route path="/archive/evidence-desk" element={<EvidenceDesk />} />
          <Route path="/archive/analyst-briefing" element={<AnalystBriefing />} />
          {/* Legacy redirects */}
          <Route path="/d/signal-radar" element={<Navigate to="/archive/signal-radar" replace />} />
          <Route path="/d/evidence-desk" element={<Navigate to="/archive/evidence-desk" replace />} />
          <Route path="/d/analyst-briefing" element={<Navigate to="/archive/analyst-briefing" replace />} />
          <Route path="/directions" element={<Navigate to="/archive" replace />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
