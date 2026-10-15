import type { Logger } from "pino";
import type { DB } from "../db/client";
import type { InstagramApi } from "../instagram/client";
import type { TokenStore } from "../instagram/tokens";
import type { Enqueue } from "./queues";

/** Everything impure the engine needs, passed explicitly (no module-level singletons). */
export type EngineDeps = {
  readonly db: DB;
  readonly enqueue: Enqueue;
  readonly ig: InstagramApi;
  readonly tokens: TokenStore;
  readonly log: Logger;
  readonly now: () => Date;
};
