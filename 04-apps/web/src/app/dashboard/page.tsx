import Link from "next/link";
import { RouteNav } from "@/app/_components/route-nav";
import { getStoryFixtures } from "@/lib/story-fixtures";
import { formatTrustFlag, freshnessLabel, trustScore } from "@/lib/trust";

export default function DashboardPage() {
  const stories = getStoryFixtures("default-feed");

  return (
    <div className="min-h-screen bg-zinc-100 py-10 font-sans text-zinc-900">
      <main className="mx-auto w-full max-w-5xl px-6">
        <RouteNav />
        <h1 className="text-3xl font-semibold">Dashboard</h1>
        <p className="mt-2 text-zinc-700">
          Story monitor with visible provenance and trust signals.
        </p>

        <div className="mt-4 rounded-xl border border-zinc-200 bg-white p-4 text-sm text-zinc-700">
          Trust policy: verify stories through linked sources before drafting.
          Low-confidence or stale stories are clearly flagged.
        </div>

        <ul className="mt-6 space-y-4">
          {stories.map((story) => (
            <li key={story.id} className="rounded-xl bg-white p-5 shadow-sm">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-semibold">{story.title}</h2>
                <span className="rounded-full bg-zinc-100 px-2 py-1 text-xs font-medium text-zinc-700">
                  {freshnessLabel(story.updatedAt)}
                </span>
                <span className="rounded-full bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700">
                  Trust {trustScore(story)}%
                </span>
              </div>
              <p className="mt-2 text-sm text-zinc-600">{story.summary}</p>
              <p className="mt-3 text-xs text-zinc-500">
                Updated {new Date(story.updatedAt).toLocaleString()}
              </p>

              {story.trustFlags.length > 0 && (
                <ul className="mt-3 flex flex-wrap gap-2">
                  {story.trustFlags.map((flag) => (
                    <li
                      key={flag}
                      className="rounded-full bg-amber-100 px-2 py-1 text-xs font-medium text-amber-800"
                    >
                      {formatTrustFlag(flag)}
                    </li>
                  ))}
                </ul>
              )}

              <div className="mt-3 rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-sm">
                <p className="font-medium text-zinc-800">
                  Provenance preview ({story.sources.length} sources)
                </p>
                <ul className="mt-2 space-y-1 text-zinc-700">
                  {story.sources.slice(0, 2).map((source) => (
                    <li key={source.id}>
                      {source.outlet} - {new Date(source.publishedAt).toLocaleTimeString()}
                    </li>
                  ))}
                </ul>
              </div>

              <Link
                href={`/story/${story.id}`}
                className="mt-4 inline-block text-sm font-medium underline"
              >
                Open story details and full sources
              </Link>
            </li>
          ))}
        </ul>
      </main>
    </div>
  );
}
