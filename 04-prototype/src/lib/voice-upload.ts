const TRANSCRIBE_ENDPOINT = "/api/transcribe";
const TRANSCRIBE_TIMEOUT_MS = 30_000;

export async function transcribeAudio(blob: Blob): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TRANSCRIBE_TIMEOUT_MS);
  try {
    const response = await fetch(TRANSCRIBE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": blob.type || "audio/webm" },
      body: blob,
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { message?: string };
      throw new Error(body.message ?? `HTTP ${response.status}`);
    }
    const result = (await response.json()) as { transcript: string };
    return result.transcript;
  } finally {
    clearTimeout(timeoutId);
  }
}
