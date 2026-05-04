import { getSupabaseClient } from "./client.mjs";
import { CONTRACT_VERSION } from "../contracts/settings-schema.mjs";

/**
 * Atomically upserts a settings row and appends an onboarding narrative row inside
 * a single Postgres transaction (via the save_settings_with_narrative RPC).
 *
 * Either both writes commit or neither does.  Throws on any DB error so the caller
 * can surface a 500 without a partially-written state in the database.
 *
 * Precondition: caller must have verified isSupabaseEnabled() before calling.
 *
 * @param {{ userId: string, settingsPayload: object, rawNarrative: string }} args
 */
export async function atomicSaveSettingsAndNarrative({ userId, settingsPayload, rawNarrative }) {
  const { contractVersion, ...dataFields } = settingsPayload;
  const { error } = await getSupabaseClient().rpc("save_settings_with_narrative", {
    p_settings_key:     `user:${userId}`,
    p_settings_data:    dataFields,
    p_contract_version: contractVersion ?? CONTRACT_VERSION,
    p_user_id:          userId,
    p_raw_text:         rawNarrative,
  });
  if (error) {
    const msg = error.message ?? "";
    if (msg.includes("relation") && msg.includes("does not exist")) {
      throw new Error(`[atomic-save] Table not found — run migration 008: ${msg}`);
    }
    if (msg.includes("Could not find the function") || msg.includes("does not exist")) {
      throw new Error(`[atomic-save] RPC not found — run migration 009: ${msg}`);
    }
    if (msg.includes("permission denied") || msg.includes("insufficient privilege")) {
      throw new Error(`[atomic-save] Permission denied — check GRANT on save_settings_with_narrative: ${msg}`);
    }
    throw new Error(`[atomic-save] RPC failed: ${msg}`);
  }
}
