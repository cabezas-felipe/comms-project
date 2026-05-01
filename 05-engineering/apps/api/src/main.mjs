import "dotenv/config";
import { app } from "./server.mjs";

const PORT = Number(process.env.TEMPO_API_PORT || 8787);
app.listen(PORT, () => {
  console.log(`@tempo/api listening on http://localhost:${PORT}`);
});
