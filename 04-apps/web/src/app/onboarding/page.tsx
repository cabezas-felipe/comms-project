import Link from "next/link";
import { RouteNav } from "@/app/_components/route-nav";

export default function OnboardingPage() {
  return (
    <div className="min-h-screen bg-zinc-100 py-10 font-sans text-zinc-900">
      <main className="mx-auto w-full max-w-3xl px-6">
        <RouteNav />
        <h1 className="text-3xl font-semibold">Onboarding</h1>
        <p className="mt-2 text-zinc-700">
          Placeholder onboarding step with simple progression.
        </p>

        <div className="mt-6 rounded-xl bg-white p-6 shadow-sm">
          <p className="text-sm text-zinc-600">Step 2 placeholder content</p>
          <p className="mt-3 text-zinc-800">
            Connect interests, geos, and topics before profile confirmation.
          </p>
          <Link
            href="/profile-confirmation"
            className="mt-5 inline-block rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white"
          >
            Continue to profile confirmation
          </Link>
        </div>
      </main>
    </div>
  );
}
