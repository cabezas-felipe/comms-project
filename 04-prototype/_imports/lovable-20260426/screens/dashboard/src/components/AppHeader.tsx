import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { formatClock } from "@/lib/format";
import { useEffect, useState } from "react";
import { Settings as SettingsIcon, LogOut } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "sonner";

const NAV = [
  { to: "/dashboard", label: "Feed" },
  { to: "/settings", label: "Settings" },
  { to: "/archive", label: "Archive" },
];

export default function AppHeader() {
  const [now, setNow] = useState(new Date());
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);

  // Hide chrome on landing, auth, and onboarding
  const path = location.pathname;
  if (path === "/" || path === "/onboarding" || path.startsWith("/auth")) return null;

  const handleLogOut = () => {
    toast.success("Logged out.");
    navigate("/");
  };

  return (
    <header className="sticky top-0 z-30 border-b border-rule/60 bg-background/85 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-[1400px] items-center justify-between px-6">
        <div className="flex items-center gap-8">
          <NavLink to="/dashboard" className="flex flex-col leading-none">
            <span className="font-display text-2xl font-semibold leading-none tracking-tight">
              Tempo
            </span>
            <span className="mt-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              The news, in tempo
            </span>
          </NavLink>
        </div>

        <div className="flex items-center gap-5">
          <div className="hidden text-right md:block">
            <div className="eyebrow leading-none">Last refresh</div>
            <div className="font-mono text-xs text-foreground">{formatClock(now)}</div>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label="Open account menu"
              className="rounded-sm p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <SettingsIcon className="h-4 w-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onSelect={() => navigate("/settings")} className="gap-2">
                <SettingsIcon className="h-4 w-4" />
                Settings
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={handleLogOut} className="gap-2">
                <LogOut className="h-4 w-4" />
                Log out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  );
}
