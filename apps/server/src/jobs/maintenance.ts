import { triggerNode, type CommentEvent } from "@app/core";
import { INSTAGRAM_PROVIDER } from "../auth";
import type { EngineDeps } from "../engine/deps";
import { ingestEvents } from "../engine/router";

/**
 * Instagram long-lived tokens last 60 days and can be refreshed once they are 24h old.
 * There is no refresh_token: the access token itself is exchanged for a new one.
 */
export const refreshTokens = async (deps: EngineDeps): Promise<void> => {
  const now = deps.now().getTime();
  const due = await deps.db
    .selectFrom("account")
    .select(["accountId"])
    .where("providerId", "=", INSTAGRAM_PROVIDER)
    .where("accessTokenExpiresAt", "<", new Date(now + 14 * 86400_000))
    .where("accessTokenExpiresAt", ">", new Date(now))
    .where("updatedAt", "<", new Date(now - 86400_000))
    .execute();
  for (const { accountId } of due) {
    try {
      const fresh = await deps.ig.refreshToken(await deps.tokens.get(accountId));
      await deps.tokens.set(accountId, fresh.accessToken, fresh.expiresAt);
      deps.log.info({ accountId }, "instagram token refreshed");
    } catch (e) {
      deps.log.error({ accountId, error: String(e) }, "instagram token refresh failed");
    }
  }
};

/**
 * Safety net for webhooks: Meta drops deliveries after 36h of failures and comment webhooks
 * require Advanced Access. Polls recent comments on publications watched by active comment
 * automations and feeds them through the same deduplicated inbox as webhooks.
 */
export const reconcileComments = async (deps: EngineDeps, lookbackMs = 60 * 60_000): Promise<void> => {
  const automations = await deps.db
    .selectFrom("automations as a")
    .innerJoin("automation_versions as v", "v.id", "a.active_version_id")
    .select(["a.ig_account_id", "v.graph"])
    .where("a.status", "=", "active")
    .execute();

  const watched = new Map<string, Set<string> | "all">();
  for (const a of automations) {
    const trigger = triggerNode(a.graph);
    if (trigger?.type !== "trigger.comment") continue;
    const pubs = (trigger.config as { publications?: { mode: string; items?: { mediaId: string }[] } }).publications;
    const prev = watched.get(a.ig_account_id);
    if (pubs?.mode !== "list" || prev === "all") watched.set(a.ig_account_id, "all");
    else watched.set(a.ig_account_id, new Set([...(prev ?? []), ...(pubs.items ?? []).map((i) => i.mediaId)]));
  }

  const since = deps.now().getTime() - lookbackMs;
  for (const [accountId, media] of watched) {
    try {
      const token = await deps.tokens.get(accountId);
      const mediaIds = media === "all" ? (await deps.ig.listMedia(token)).slice(0, 10).map((m) => m.id) : [...media];
      for (const mediaId of mediaIds) {
        const events: CommentEvent[] = (await deps.ig.listComments(token, mediaId))
          .filter((c) => c.from && c.from.id !== accountId && Date.parse(c.timestamp) >= since)
          .map((c) => ({
            kind: "comment",
            accountId,
            externalId: `comment:${c.id}`,
            commentId: c.id,
            mediaId,
            parentId: null,
            text: c.text,
            from: c.from!,
            occurredAt: new Date(c.timestamp).toISOString(),
          }));
        const r = await ingestEvents(deps, events);
        if (r.inserted > 0) deps.log.warn({ accountId, mediaId, ...r }, "reconciler found comments missed by webhooks");
      }
    } catch (e) {
      deps.log.error({ accountId, error: String(e) }, "comment reconciliation failed");
    }
  }
};
