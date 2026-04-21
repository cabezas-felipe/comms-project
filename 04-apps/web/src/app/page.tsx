import Link from "next/link";
import { RouteNav } from "@/app/_components/route-nav";

export default function Home() {
  return (
    <div className="min-h-screen bg-zinc-100 py-10 font-sans text-zinc-900">
      <main className="mx-auto w-full max-w-4xl px-6">
        <RouteNav />
        <h1 className="text-3xl font-semibold">Comms MVP route skeleton</h1>
        <p className="mt-2 text-zinc-700">
          Use this landing page to navigate Step 2 routes.
        </p>
        <div className="mt-6 rounded-xl bg-white p-6 shadow-sm">
          <p className="text-sm text-zinc-600">Quick start:</p>
          <ul className="mt-3 space-y-2 text-zinc-800">
            <li>
              <Link className="underline" href="/onboarding">
                Start onboarding flow
              </Link>
            </li>
            <li>
              <Link className="underline" href="/dashboard">
                Open fixture-driven dashboard
              </Link>
            </li>
          </ul>
        </div>
      </main>
    </div>
  );
}
