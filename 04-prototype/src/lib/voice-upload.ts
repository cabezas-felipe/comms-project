import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "./supabase";

const TRANSCRIBE_ENDPOINT = "/api/transcribe";
const TRANSCRIBE_TIMEOUT_MS = 30_000;
const VOICE_BUCKET = "voice-notes";

export function buildVoiceObjectPath(userId: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(36).slice(2, 8);
  return `${userId}/${ts}-${rand}.webm`;
}

/**
 * Returns "skipped" only when the caller is unauthenticated — the only case
 * where showing a user-facing toast makes sense. All other outcomes (storage
 * not configured, upload error) are silently treated as "uploaded" so noise is
 * avoided for authenticated users.
 */
export async function uploadVoiceNote(blob: Blob): Promise<"uploaded" | "skipped"> {
  try {
    const { data } = await supabase.auth.getSession();
    const userId = data.session?.user?.id;
    if (!userId) return "skipped";
    if (!("storage" in supabase)) return "uploaded";
    const path = buildVoiceObjectPath(userId);
    await (supabase as unknown as SupabaseClient).storage
      .from(VOICE_BUCKET)
      .upload(path, blob, { contentType: blob.type || "audio/webm", upsert: false });
    return "uploaded";
  } catch {
    return "uploaded"; // swallow errors — never blocks transcription
  }
}

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
