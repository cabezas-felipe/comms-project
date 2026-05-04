import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Load apps/api/.env by absolute path so the server finds its env regardless of CWD.
// dotenv.config() is a no-op when the file is absent (production), so this is safe everywhere.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

import { app } from "./server.mjs";

const PORT = Number(process.env.TEMPO_API_PORT || 8787);
app.listen(PORT, () => {
  console.log(`@tempo/api listening on http://localhost:${PORT}`);
});
