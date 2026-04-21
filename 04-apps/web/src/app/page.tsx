import { getStoryFixtures } from "@/lib/story-fixtures";
import { FixtureScenario } from "@/lib/story";

export default function Home() {
  const scenario: FixtureScenario = "default-feed";
  const stories = getStoryFixtures(scenario);

  return (
    <div className="min-h-screen bg-zinc-100 py-10 font-sans text-zinc-900">
      <main className="mx-auto w-full max-w-5xl px-6">
        <header className="mb-8">
          <p className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
            Comms MVP - Step 1 fixtures
          </p>
          <h1 className="mt-2 text-3xl font-semibold">
            Story feed fixtures ({scenario})
          </h1>
          <p className="mt-2 text-zinc-600">
            Temporary fixture viewer to validate typed story states before full
            UX flows.
          </p>
        </header>

        {stories.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-300 bg-white p-8">
            <h2 className="text-lg font-semibold">No stories available</h2>
            <p className="mt-2 text-zinc-600">
              This scenario simulates an empty feed state for UX testing.
            </p>
          </div>
        ) : (
          <ul className="space-y-4">
            {stories.map((story) => (
              <li key={story.id} className="rounded-xl bg-white p-5 shadow-sm">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="text-lg font-semibold">{story.title}</h2>
                    <p className="mt-2 text-sm text-zinc-600">{story.summary}</p>
                  </div>
                  <span className="rounded-full bg-zinc-100 px-3 py-1 text-xs font-medium">
                    Confidence {Math.round(story.confidence * 100)}%
                  </span>
                </div>
                <p className="mt-3 text-xs text-zinc-500">
                  Updated {new Date(story.updatedAt).toLocaleString()}
                </p>
                <p className="mt-2 text-sm">
                  <span className="font-medium">Delta:</span> {story.delta.text}
                </p>
                <p className="mt-2 text-sm">
                  <span className="font-medium">Trust flags:</span>{" "}
                  {story.trustFlags.length > 0
                    ? story.trustFlags.join(", ")
                    : "none"}
                </p>
                <p className="mt-2 text-sm text-zinc-700">
                  {story.sources.length} source(s) linked
                </p>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
