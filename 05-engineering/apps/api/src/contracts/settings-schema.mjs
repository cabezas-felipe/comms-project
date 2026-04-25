import { z } from "zod";

export const CONTRACT_VERSION = "2026-04-22-slice1";

export const settingsPayloadSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  topics: z.array(z.string().min(1)),
  keywords: z.array(z.string().min(1)),
  geographies: z.array(z.string().min(1)),
  traditionalSources: z.array(z.string().min(1)),
  socialSources: z.array(z.string().min(1)),
});
