// Shared refresh cadence — single source of truth for the dashboard refresh
// interval used by the prototype heartbeat (footer countdown, attempt gating)
// and any future API-side cadence consumer.
//
// One hour, in milliseconds.  This is the cadence at which an idle session
// becomes eligible for an automatic refresh attempt — not the same concept as
// the bootstrap "snapshot freshness" threshold or the per-feed fetch timeout,
// each of which is governed by its own constant.

export const REFRESH_INTERVAL_MS = 3_600_000;
