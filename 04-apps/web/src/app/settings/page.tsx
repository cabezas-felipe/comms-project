import { RouteNav } from "@/app/_components/route-nav";

export default function SettingsPage() {
  return (
    <div className="min-h-screen bg-zinc-100 py-10 font-sans text-zinc-900">
      <main className="mx-auto w-full max-w-3xl px-6">
        <RouteNav />
        <h1 className="text-3xl font-semibold">Settings</h1>
        <p className="mt-2 text-zinc-700">Scope and trust preference controls.</p>

        <div className="mt-6 space-y-4">
          <section className="rounded-xl bg-white p-5 shadow-sm">
            <h2 className="text-lg font-semibold">Coverage scope</h2>
            <p className="mt-2 text-sm text-zinc-600">
              Geographies: US, Colombia | Topics: 3 active
            </p>
          </section>
          <section className="rounded-xl bg-white p-5 shadow-sm">
            <h2 className="text-lg font-semibold">Trust threshold</h2>
            <p className="mt-2 text-sm text-zinc-600">
              Flag stories below 70% trust score for manual review before drafting.
            </p>
          </section>
          <section className="rounded-xl bg-white p-5 shadow-sm">
            <h2 className="text-lg font-semibold">Privacy and data handling</h2>
            <p className="mt-2 text-sm text-zinc-600">
              Voice input is optional. Transcripts remain editable before profile
              save.
            </p>
          </section>
        </div>
      </main>
    </div>
  );
}
