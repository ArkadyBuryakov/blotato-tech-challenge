import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0"])
  .default("false")
  .transform((v) => v === "true" || v === "1");

const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().default(3001),
  DATABASE_URL: z.string().default("postgres://postgres:postgres@localhost:5432/automations"),
  /** Public origin, e.g. https://demo.example.com (BetterAuth base URL, OAuth redirect host). */
  BETTER_AUTH_URL: z.string().url().default("http://localhost:3000"),
  BETTER_AUTH_SECRET: z.string().min(32).default("dev-secret-dev-secret-dev-secret-dev-secret"),
  /** `mock` replaces Instagram (OAuth + Graph API) with a local fake, for development and tests. */
  INSTAGRAM_MODE: z.enum(["live", "mock"]).default("mock"),
  INSTAGRAM_APP_ID: z.string().default(""),
  INSTAGRAM_APP_SECRET: z.string().default(""),
  INSTAGRAM_GRAPH_VERSION: z.string().default("v24.0"),
  META_WEBHOOK_VERIFY_TOKEN: z.string().default("dev-verify-token"),
  /** Enables /api/dev/* (simulate inbound comments/DMs). Never on for real customers. */
  ENABLE_DEV_TOOLS: bool,
  /** Poll recent comments as a fallback for missed webhooks (and for apps without Advanced Access). */
  COMMENT_RECONCILER: bool,
  WEB_STATIC_DIR: z.string().default("../web/out"),
});

export type Config = z.infer<typeof envSchema>;

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => {
  const cfg = envSchema.parse(env);
  if (cfg.NODE_ENV === "production" && cfg.INSTAGRAM_MODE === "live") {
    const missing = (["INSTAGRAM_APP_ID", "INSTAGRAM_APP_SECRET"] as const).filter((k) => !cfg[k]);
    if (missing.length) throw new Error(`Missing env: ${missing.join(", ")}`);
  }
  return cfg;
};
