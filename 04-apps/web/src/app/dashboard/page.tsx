import Link from "next/link";
import { RouteNav } from "@/app/_components/route-nav";
import { getStoryFixtures } from "@/lib/story-fixtures";

export default function DashboardPage() {
  const stories = getStoryFixtures("default-feed");

  return (
    <div className="min-h-screen bg-zinc-100 py-10 font-sans text-zinc-900">
      <main className="mx-auto w-full max-w-5xl px-6">
        <RouteNav />
        <h1 className="text-3xl font-semibold">Dashboard</h1>
        <p className="mt-2 text-zinc-700">Fixture-driven story list.</p>

        <ul className="mt-6 space-y-4">
          {stories.map((story) => (
            <li key={story.id} className="rounded-xl bg-white p-5 shadow-sm">
              <h2 className="text-lg font-semibold">{story.title}</h2>
              <p className="mt-2 text-sm text-zinc-600">{story.summary}</p>
              <Link
                href={`/story/${story.id}`}
                className="mt-4 inline-block text-sm font-medium underline"
              >
                Open story details
              </Link>
            </li>
          ))}
        </ul>
      </main>
    </div>
  );
}
