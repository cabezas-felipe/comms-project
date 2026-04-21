import Link from "next/link";
import { notFound } from "next/navigation";
import { RouteNav } from "@/app/_components/route-nav";
import { getStoryFixtures } from "@/lib/story-fixtures";

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
          <p className="mt-3 text-sm text-zinc-600">Delta: {story.delta.text}</p>
          <p className="mt-2 text-sm text-zinc-600">
            Sources: {story.sources.length} | Confidence: {Math.round(story.confidence * 100)}%
          </p>
          <Link href="/dashboard" className="mt-5 inline-block text-sm font-medium underline">
            Back to dashboard
          </Link>
        </div>
      </main>
    </div>
  );
}
