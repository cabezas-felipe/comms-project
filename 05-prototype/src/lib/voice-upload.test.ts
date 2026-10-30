import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { transcribeAudio } from "@/lib/voice-upload";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── transcribeAudio ───────────────────────────────────────────────────────
describe("transcribeAudio", () => {
  it("returns transcript text on 200 OK", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ transcript: "hello world" }),
    });
    const result = await transcribeAudio(new Blob(["audio"]));
    expect(result).toBe("hello world");
  });

  it("sends the blob as body with correct content-type header", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ transcript: "" }),
    });
    const blob = new Blob(["audio"], { type: "audio/webm;codecs=opus" });
    await transcribeAudio(blob);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/transcribe");
    expect((init as RequestInit).headers).toMatchObject({
      "Content-Type": "audio/webm;codecs=opus",
    });
    expect((init as RequestInit).body).toBe(blob);
  });

  it("throws with server message on non-OK response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => ({ message: "Transcription unavailable." }),
    });
    await expect(transcribeAudio(new Blob(["audio"]))).rejects.toThrow(
      "Transcription unavailable."
    );
  });

  it("falls back to HTTP status string when error body has no message", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: async () => ({}),
    });
    await expect(transcribeAudio(new Blob(["audio"]))).rejects.toThrow("HTTP 502");
  });

  it("passes an AbortSignal to fetch (timeout is wired)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ transcript: "" }),
    });
    await transcribeAudio(new Blob(["audio"]));
    const [, init] = mockFetch.mock.calls[0];
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it("propagates AbortError when fetch is aborted", async () => {
    const abortErr = new DOMException("aborted", "AbortError");
    mockFetch.mockRejectedValueOnce(abortErr);
    await expect(transcribeAudio(new Blob(["audio"]))).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});
