import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildVoiceObjectPath, uploadVoiceNote, transcribeAudio } from "@/lib/voice-upload";

// ── hoisted mock setup ────────────────────────────────────────────────────
const { mockUpload, mockFrom, mockGetSession } = vi.hoisted(() => ({
  mockUpload: vi.fn().mockResolvedValue({ error: null }),
  mockFrom: vi.fn(),
  mockGetSession: vi.fn(),
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: { getSession: mockGetSession },
    storage: { from: mockFrom },
  },
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
  vi.clearAllMocks();
  mockFrom.mockReturnValue({ upload: mockUpload });
});

afterEach(() => {
  vi.useRealTimers();
});

// ── buildVoiceObjectPath ──────────────────────────────────────────────────
describe("buildVoiceObjectPath", () => {
  it("is prefixed with the user id and a single slash", () => {
    const userId = "user-abc-123";
    const path = buildVoiceObjectPath(userId);
    expect(path.startsWith(`${userId}/`)).toBe(true);
  });

  it("ends with .webm", () => {
    expect(buildVoiceObjectPath("u1").endsWith(".webm")).toBe(true);
  });

  it("never produces a root-level path (no leading slash, folder segment present)", () => {
    const path = buildVoiceObjectPath("u1");
    expect(path.startsWith("/")).toBe(false);
    const slash = path.indexOf("/");
    expect(slash).toBeGreaterThan(0); // folder separator is NOT the first char
  });

  it("filename segment starts with an ISO year (timestamp present)", () => {
    const filename = buildVoiceObjectPath("u1").split("/")[1];
    expect(filename).toMatch(/^\d{4}-/);
  });

  it("produces unique paths on successive calls (collision resistance)", () => {
    const paths = new Set(Array.from({ length: 30 }, () => buildVoiceObjectPath("u1")));
    expect(paths.size).toBe(30);
  });

  it("preserves arbitrary user id characters including hyphens and underscores", () => {
    const userId = "org_12-34_abcd";
    const path = buildVoiceObjectPath(userId);
    expect(path.startsWith(`${userId}/`)).toBe(true);
  });
});

// ── uploadVoiceNote — policy enforcement ─────────────────────────────────
describe("uploadVoiceNote — policy enforcement", () => {
  it("returns 'skipped' and does not call storage when unauthenticated", async () => {
    mockGetSession.mockResolvedValue({ data: { session: null } });
    const result = await uploadVoiceNote(new Blob(["audio"], { type: "audio/webm" }));
    expect(result).toBe("skipped");
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it("returns 'uploaded' and uses voice-notes bucket when authenticated", async () => {
    mockGetSession.mockResolvedValue({
      data: { session: { user: { id: "real-user-id" } } },
    });
    const result = await uploadVoiceNote(new Blob(["audio"], { type: "audio/webm" }));
    expect(result).toBe("uploaded");
    expect(mockFrom).toHaveBeenCalledWith("voice-notes");
  });

  it("returns 'uploaded' with a user-prefixed .webm path when authenticated", async () => {
    const userId = "real-user-id";
    mockGetSession.mockResolvedValue({
      data: { session: { user: { id: userId } } },
    });
    const blob = new Blob(["audio"], { type: "audio/webm" });
    const result = await uploadVoiceNote(blob);

    expect(result).toBe("uploaded");
    expect(mockUpload).toHaveBeenCalledOnce();
    const [uploadedPath, uploadedBlob, opts] = mockUpload.mock.calls[0];
    expect(uploadedPath.startsWith(`${userId}/`)).toBe(true);
    expect(uploadedPath.endsWith(".webm")).toBe(true);
    expect(uploadedBlob).toBe(blob);
    expect(opts).toMatchObject({ upsert: false });
  });

  it("returns 'uploaded' (not 'skipped') when authenticated but storage upload rejects", async () => {
    mockGetSession.mockResolvedValue({
      data: { session: { user: { id: "uid" } } },
    });
    mockUpload.mockRejectedValueOnce(new Error("bucket not found"));
    await expect(
      uploadVoiceNote(new Blob(["audio"], { type: "audio/webm" }))
    ).resolves.toBe("uploaded");
  });

  it("returns 'uploaded' (not 'skipped') when getSession itself throws (unconfigured Supabase)", async () => {
    mockGetSession.mockRejectedValueOnce(new Error("not configured"));
    await expect(
      uploadVoiceNote(new Blob(["audio"], { type: "audio/webm" }))
    ).resolves.toBe("uploaded");
  });
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
