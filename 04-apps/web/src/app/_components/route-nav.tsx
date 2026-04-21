import Link from "next/link";

const LINKS = [
  { href: "/", label: "Home" },
  { href: "/onboarding", label: "Onboarding" },
  { href: "/profile-confirmation", label: "Profile confirmation" },
  { href: "/dashboard", label: "Dashboard" },
  { href: "/settings", label: "Settings" },
];

export function RouteNav() {
  return (
    <nav className="mb-6 flex flex-wrap gap-2">
      {LINKS.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          className="rounded-full bg-zinc-200 px-3 py-1 text-sm text-zinc-800 hover:bg-zinc-300"
        >
          {link.label}
        </Link>
      ))}
    </nav>
  );
}
