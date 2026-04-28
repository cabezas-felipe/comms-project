import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { formatClock } from "@/lib/format";
import { useEffect, useState } from "react";
import { Settings as SettingsIcon, LogOut } from "lucide-react";
import { useAuth, getProtoSession } from "@/lib/auth";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const NAV = [
  { to: "/dashboard", label: "Feed" },
  { to: "/settings", label: "Settings" },
  { to: "/archive", label: "Archive" },
];

export default function AppHeader() {
  const [now, setNow] = useState(new Date());
  const location = useLocation();
  const navigate = useNavigate();
  const { logout } = useAuth();
  const isDevPreview =
    import.meta.env.DEV &&
    new URLSearchParams(location.search).get("preview") === "1";
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);

  // Hide chrome on landing/onboarding; in prod also hide until proto session is set.
  if (["/", "/onboarding"].includes(location.pathname)) return null;
  if (!import.meta.env.DEV && !getProtoSession()) return null;

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
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Open menu"
                className="rounded-sm p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              >
                <SettingsIcon className="h-4 w-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              <DropdownMenuItem onClick={() => navigate("/settings")}>
                <SettingsIcon className="mr-2 h-4 w-4" />
                Settings
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={logout}>
                <LogOut className="mr-2 h-4 w-4" />
                Log out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  );
}
