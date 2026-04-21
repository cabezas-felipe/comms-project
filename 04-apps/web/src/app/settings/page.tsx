import { RouteNav } from "@/app/_components/route-nav";

export default function SettingsPage() {
  return (
    <div className="min-h-screen bg-zinc-100 py-10 font-sans text-zinc-900">
      <main className="mx-auto w-full max-w-3xl px-6">
        <RouteNav />
        <h1 className="text-3xl font-semibold">Settings</h1>
        <p className="mt-2 text-zinc-700">
          Placeholder settings route for notification and source preferences.
        </p>
      </main>
    </div>
  );
}
