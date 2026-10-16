/**
 * Port to Instagram (Instagram API with Instagram Login, graph.instagram.com).
 * The engine only depends on this record of functions; `live` and `mock` are interchangeable.
 */

export type Recipient = { readonly id: string } | { readonly comment_id: string };

export type Media = {
  readonly id: string;
  readonly permalink: string;
  readonly caption: string;
  readonly thumbnailUrl: string | null;
  readonly timestamp: string;
};

export type RemoteComment = {
  readonly id: string;
  readonly text: string;
  readonly timestamp: string;
  readonly from: { id: string; username: string } | null;
};

export type InstagramApi = {
  /** `recipientId` is the IGSID Instagram delivered to (for a private reply: the comment's author). */
  readonly sendMessage: (token: string, recipient: Recipient, text: string) => Promise<{ messageId: string; recipientId: string }>;
  readonly replyToComment: (token: string, commentId: string, text: string) => Promise<{ replyId: string }>;
  readonly listMedia: (token: string) => Promise<readonly Media[]>;
  readonly listComments: (token: string, mediaId: string) => Promise<readonly RemoteComment[]>;
  readonly getUserProfile: (token: string, igsid: string) => Promise<{ username: string; name: string } | null>;
  readonly subscribeWebhooks: (token: string) => Promise<void>;
  readonly refreshToken: (token: string) => Promise<{ accessToken: string; expiresAt: Date }>;
};

/** `transient` errors are retried by the job queue; others fail the step immediately. */
export class MetaApiError extends Error {
  constructor(
    message: string,
    readonly transient: boolean,
    readonly code?: number,
  ) {
    super(message);
    this.name = "MetaApiError";
  }
}

// Throttling / temporary codes per Graph API docs.
const TRANSIENT_CODES = new Set([1, 2, 4, 17, 32, 341, 613]);

type GraphError = { error?: { message?: string; code?: number; is_transient?: boolean } };

export const createLiveInstagramApi = (opts: { version: string }): InstagramApi => {
  const base = `https://graph.instagram.com/${opts.version}`;

  const call = async <T>(
    token: string,
    method: "GET" | "POST",
    path: string,
    params: Record<string, string> = {},
    body?: unknown,
  ): Promise<T> => {
    const url = new URL(path.startsWith("http") ? path : `${base}${path}`);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      throw new MetaApiError(`Network error: ${(e as Error).message}`, true);
    }
    const json = (await res.json().catch(() => ({}))) as T & GraphError;
    if (!res.ok || json.error) {
      const err = json.error ?? {};
      const transient = res.status >= 500 || err.is_transient === true || TRANSIENT_CODES.has(err.code ?? -1);
      throw new MetaApiError(err.message ?? `HTTP ${res.status}`, transient, err.code);
    }
    return json;
  };

  return {
    sendMessage: async (token, recipient, text) => {
      const r = await call<{ message_id: string; recipient_id: string }>(token, "POST", "/me/messages", {}, { recipient, message: { text } });
      return { messageId: r.message_id, recipientId: r.recipient_id };
    },
    replyToComment: async (token, commentId, text) => {
      const r = await call<{ id: string }>(token, "POST", `/${commentId}/replies`, { message: text });
      return { replyId: r.id };
    },
    listMedia: async (token) => {
      const r = await call<{ data: { id: string; permalink: string; caption?: string; thumbnail_url?: string; media_url?: string; media_type: string; timestamp: string }[] }>(
        token, "GET", "/me/media", { fields: "id,permalink,caption,media_type,media_url,thumbnail_url,timestamp", limit: "50" },
      );
      return r.data.map((m) => ({
        id: m.id,
        permalink: m.permalink,
        caption: m.caption ?? "",
        thumbnailUrl: m.thumbnail_url ?? (m.media_type === "VIDEO" ? null : (m.media_url ?? null)),
        timestamp: m.timestamp,
      }));
    },
    listComments: async (token, mediaId) => {
      const r = await call<{ data: { id: string; text: string; timestamp: string; from?: { id: string; username: string } }[] }>(
        token, "GET", `/${mediaId}/comments`, { fields: "id,text,timestamp,from", limit: "50" },
      );
      return r.data.map((c) => ({ id: c.id, text: c.text, timestamp: c.timestamp, from: c.from ?? null }));
    },
    getUserProfile: async (token, igsid) =>
      call<{ username?: string; name?: string }>(token, "GET", `/${igsid}`, { fields: "username,name" })
        .then((p) => ({ username: p.username ?? "", name: p.name ?? "" }))
        .catch(() => null),
    subscribeWebhooks: async (token) => {
      await call(token, "POST", "/me/subscribed_apps", { subscribed_fields: "comments,messages" });
    },
    refreshToken: async (token) => {
      const r = await call<{ access_token: string; expires_in: number }>(
        token, "GET", "https://graph.instagram.com/refresh_access_token", { grant_type: "ig_refresh_token", access_token: token },
      );
      return { accessToken: r.access_token, expiresAt: new Date(Date.now() + r.expires_in * 1000) };
    },
  };
};
