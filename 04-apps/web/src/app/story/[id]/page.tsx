import Link from "next/link";
import { notFound } from "next/navigation";
import { RouteNav } from "@/app/_components/route-nav";
import { getStoryFixtures } from "@/lib/story-fixtures";
import { formatTrustFlag, freshnessLabel, trustScore } from "@/lib/trust";

interface StoryDetailPageProps {
  params: Promise<{ id: string }>;
}

export default async function StoryDetailPage({ params }: StoryDetailPageProps) {
  const { id } = await params;
  const stories = getStoryFixtures("default-feed");
  const story = stories.find((item) => item.id === id);

  if (!story) {
    notFound();
  }

  return (
    <div className="min-h-screen bg-zinc-100 py-10 font-sans text-zinc-900">
      <main className="mx-auto w-full max-w-4xl px-6">
        <RouteNav />
        <h1 className="text-3xl font-semibold">Story detail</h1>
        <div className="mt-6 rounded-xl bg-white p-6 shadow-sm">
          <h2 className="text-xl font-semibold">{story.title}</h2>
          <p className="mt-3 text-zinc-700">{story.summary}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <span className="rounded-full bg-zinc-100 px-2 py-1 text-xs font-medium text-zinc-700">
              {freshnessLabel(story.updatedAt)}
            </span>
            <span className="rounded-full bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700">
              Trust {trustScore(story)}%
            </span>
            <span className="rounded-full bg-zinc-100 px-2 py-1 text-xs font-medium text-zinc-700">
              Confidence {Math.round(story.confidence * 100)}%
            </span>
          </div>
          <p className="mt-3 text-sm text-zinc-600">Delta: {story.delta.text}</p>
          <p className="mt-2 text-sm text-zinc-600">
            Last updated {new Date(story.updatedAt).toLocaleString()}
          </p>

          {story.trustFlags.length > 0 ? (
            <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3">
              <p className="text-sm font-medium text-amber-900">Review before trusting</p>
              <ul className="mt-2 list-inside list-disc text-sm text-amber-800">
                {story.trustFlags.map((flag) => (
                  <li key={flag}>{formatTrustFlag(flag)}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
              No active trust warnings. Still verify core claims via sources below.
            </p>
          )}

          <section className="mt-5">
            <h3 className="text-base font-semibold">Sources and provenance</h3>
            <ul className="mt-3 space-y-2">
              {story.sources.map((source) => (
                <li key={source.id} className="rounded-lg border border-zinc-200 p-3 text-sm">
                  <p className="font-medium text-zinc-800">{source.outlet}</p>
                  <p className="text-zinc-700">{source.title}</p>
                  <p className="mt-1 text-xs text-zinc-500">
                    {source.sourceType} - {source.geo} -{" "}
                    {new Date(source.publishedAt).toLocaleString()}
                  </p>
                  <a
                    href={source.url}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 inline-block text-sm font-medium underline"
                  >
                    Open original source
                  </a>
                </li>
              ))}
            </ul>
          </section>

          <Link href="/dashboard" className="mt-5 inline-block text-sm font-medium underline">
            Back to dashboard
          </Link>
        </div>
      </main>
    </div>
  );
}
