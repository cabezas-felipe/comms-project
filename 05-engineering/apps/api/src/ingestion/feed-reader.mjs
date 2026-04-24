// Reads raw source items from the configured data directory.
// This is the ingestion boundary: swap this module to pull from RSS, a DB, or an HTTP API
// without changing any downstream normalization or dashboard-building logic.

import fs from "node:fs/promises";
import path from "node:path";

export async function readFeedItems(dataDir) {
  const file = path.join(dataDir, "source-items.json");
  const content = await fs.readFile(file, "utf8");
  return JSON.parse(content);
}
