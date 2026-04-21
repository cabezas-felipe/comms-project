import Link from "next/link";
import { RouteNav } from "@/app/_components/route-nav";

export default function ProfileConfirmationPage() {
  return (
    <div className="min-h-screen bg-zinc-100 py-10 font-sans text-zinc-900">
      <main className="mx-auto w-full max-w-3xl px-6">
        <RouteNav />
        <h1 className="text-3xl font-semibold">Profile confirmation</h1>
        <p className="mt-2 text-zinc-700">
          Placeholder step to confirm selected preferences.
        </p>

        <div className="mt-6 rounded-xl bg-white p-6 shadow-sm">
          <p className="text-zinc-800">Review and confirm profile setup.</p>
          <Link
            href="/dashboard"
            className="mt-5 inline-block rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white"
          >
            Go to dashboard
          </Link>
        </div>
      </main>
    </div>
  );
}
