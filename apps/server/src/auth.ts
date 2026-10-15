import { betterAuth } from "better-auth";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import type { Config } from "./config";
import type { DB } from "./db/client";
import type { InstagramApi } from "./instagram/client";
import { MOCK_ACCOUNT } from "./instagram/mock";

export const INSTAGRAM_PROVIDER = "instagram";
export const INSTAGRAM_SCOPES = [
  "instagram_business_basic",
  "instagram_business_manage_comments",
  "instagram_business_manage_messages",
];

type TokenResponse = { access_token: string; user_id?: string | number; permissions?: string[] | string };

/**
 * Instagram Login is not a standard OAuth provider:
 * - the code exchange returns a short-lived token (sometimes wrapped in `data: [...]`),
 *   which must be exchanged for a 60-day long-lived token;
 * - there is no refresh_token: the access token itself is refreshed (see jobs/maintenance.ts);
 * - there is no email, so we synthesize a non-routable one for BetterAuth's user model.
 */
const liveInstagramOAuth = (cfg: Config, ig: InstagramApi, log: (m: string, d: object) => void) => ({
  authorizationUrl: "https://www.instagram.com/oauth/authorize",
  getToken: async ({ code, redirectURI }: { code: string; redirectURI: string }) => {
    const res = await fetch("https://api.instagram.com/oauth/access_token", {
      method: "POST",
      body: new URLSearchParams({
        client_id: cfg.INSTAGRAM_APP_ID,
        client_secret: cfg.INSTAGRAM_APP_SECRET,
        grant_type: "authorization_code",
        redirect_uri: redirectURI,
        code,
      }),
    });
    const json = (await res.json()) as TokenResponse & { data?: TokenResponse[] };
    const short = json.data?.[0] ?? json;
    if (!res.ok || !short.access_token) throw new Error(`Instagram token exchange failed: ${JSON.stringify(json)}`);

    const longUrl = new URL("https://graph.instagram.com/access_token");
    longUrl.search = new URLSearchParams({
      grant_type: "ig_exchange_token",
      client_secret: cfg.INSTAGRAM_APP_SECRET,
      access_token: short.access_token,
    }).toString();
    const long = (await (await fetch(longUrl)).json()) as { access_token: string; expires_in: number };
    const scopes = Array.isArray(short.permissions) ? short.permissions : String(short.permissions ?? "").split(",");
    return {
      accessToken: long.access_token,
      accessTokenExpiresAt: new Date(Date.now() + long.expires_in * 1000),
      scopes,
      tokenType: "bearer",
    };
  },
  getUserInfo: async (tokens: { accessToken?: string }) => {
    const url = new URL(`https://graph.instagram.com/${cfg.INSTAGRAM_GRAPH_VERSION}/me`);
    url.searchParams.set("fields", "user_id,username,name,profile_picture_url");
    const res = await fetch(url, { headers: { authorization: `Bearer ${tokens.accessToken}` } });
    const me = (await res.json()) as { user_id: string; username: string; name?: string; profile_picture_url?: string };
    if (!res.ok || !me.user_id) return null;
    // Subscribing the account to our app's webhooks is part of connecting it.
    await ig.subscribeWebhooks(tokens.accessToken!).catch((e) => log("webhook subscription failed", { error: String(e) }));
    return profile(String(me.user_id), me.username, me.name, me.profile_picture_url);
  },
});

const mockInstagramOAuth = (cfg: Config) => ({
  authorizationUrl: `${cfg.BETTER_AUTH_URL}/api/dev/oauth/authorize`,
  getToken: async () => ({
    accessToken: `mock_token_${Date.now()}`,
    accessTokenExpiresAt: new Date(Date.now() + 60 * 86400_000),
    scopes: INSTAGRAM_SCOPES,
    tokenType: "bearer",
  }),
  getUserInfo: async () => profile(MOCK_ACCOUNT.id, MOCK_ACCOUNT.username, MOCK_ACCOUNT.name),
});

const profile = (igId: string, username: string, name?: string, image?: string) => ({
  id: igId,
  username,
  // BetterAuth's `name` holds the Instagram handle; that is what the UI shows.
  name: username || name || igId,
  email: `${igId}@instagram.invalid`,
  emailVerified: false,
  image,
});

export const createAuth = (cfg: Config, db: DB, ig: InstagramApi, log: (m: string, d: object) => void) =>
  betterAuth({
    baseURL: cfg.BETTER_AUTH_URL,
    secret: cfg.BETTER_AUTH_SECRET,
    database: { db, type: "postgres" },
    account: {
      // Long-lived Instagram tokens are the credentials automations run with: encrypt at rest.
      encryptOAuthTokens: true,
      // Re-login refreshes the stored token and granted scopes.
      updateAccountOnSignIn: true,
    },
    plugins: [
      genericOAuth({
        config: [
          {
            providerId: INSTAGRAM_PROVIDER,
            name: "Instagram",
            clientId: cfg.INSTAGRAM_APP_ID || "mock",
            clientSecret: cfg.INSTAGRAM_APP_SECRET || "mock",
            // Instagram expects comma-separated scopes (BetterAuth joins with spaces, and `scope`
            // cannot be overridden), so pass them as one pre-joined entry. No PKCE support.
            scopes: [INSTAGRAM_SCOPES.join(",")],
            pkce: false,
            accountSubject: ({ profile }) => String(profile.id),
            ...(cfg.INSTAGRAM_MODE === "mock" ? mockInstagramOAuth(cfg) : liveInstagramOAuth(cfg, ig, log)),
          },
        ],
      }),
    ],
  });

export type Auth = ReturnType<typeof createAuth>;
