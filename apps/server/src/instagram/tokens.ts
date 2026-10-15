import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { INSTAGRAM_PROVIDER } from "../auth";
import type { DB } from "../db/client";
import { MetaApiError } from "./client";

/**
 * Instagram credentials live only in BetterAuth's `account` row (encrypted with the auth secret):
 * no separate credential store for automations.
 */
export type TokenStore = {
  readonly get: (igAccountId: string) => Promise<string>;
  readonly set: (igAccountId: string, token: string, expiresAt: Date) => Promise<void>;
};

// Mirrors better-auth's own heuristic for values written with encryptOAuthTokens.
const looksEncrypted = (t: string) => t.startsWith("$ba$") || (t.length % 2 === 0 && /^[0-9a-f]+$/i.test(t));

export const createTokenStore = (db: DB, secret: string): TokenStore => ({
  get: async (igAccountId) => {
    const row = await db
      .selectFrom("account")
      .select(["accessToken", "accessTokenExpiresAt"])
      .where("providerId", "=", INSTAGRAM_PROVIDER)
      .where("accountId", "=", igAccountId)
      .executeTakeFirst();
    if (!row?.accessToken) throw new MetaApiError("Instagram account is not connected", false);
    if (row.accessTokenExpiresAt && row.accessTokenExpiresAt < new Date())
      throw new MetaApiError("Instagram token expired: the user must reconnect", false);
    return looksEncrypted(row.accessToken) ? symmetricDecrypt({ key: secret, data: row.accessToken }) : row.accessToken;
  },
  set: async (igAccountId, token, expiresAt) => {
    await db
      .updateTable("account")
      .set({ accessToken: await symmetricEncrypt({ key: secret, data: token }), accessTokenExpiresAt: expiresAt, updatedAt: new Date() })
      .where("providerId", "=", INSTAGRAM_PROVIDER)
      .where("accountId", "=", igAccountId)
      .execute();
  },
});
