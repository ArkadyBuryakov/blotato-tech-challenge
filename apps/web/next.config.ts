import type { NextConfig } from "next";

const isBuild = process.env.NODE_ENV === "production";

/**
 * Production: static export served by Fastify from the same origin (`out/`).
 * Development: `next dev` proxies /api/* to the Fastify dev server so cookies stay first-party.
 */
const config: NextConfig = {
  output: isBuild ? "export" : undefined,
  trailingSlash: true,
  // Never redirect /api/foo -> /api/foo/ (would break API calls proxied in dev).
  skipTrailingSlashRedirect: true,
  transpilePackages: ["@app/core"],
  images: { unoptimized: true },
  // Type checking runs separately (`pnpm typecheck`) to keep the build fast.
  typescript: { ignoreBuildErrors: true },
  ...(isBuild
    ? {}
    : {
        rewrites: async () => [{ source: "/api/:path*", destination: `${process.env.API_ORIGIN ?? "http://localhost:3001"}/api/:path*` }],
      }),
};

export default config;
