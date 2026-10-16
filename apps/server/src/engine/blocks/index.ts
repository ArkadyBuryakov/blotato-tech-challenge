import type { NodeType } from "@app/core";
import { commentReplyHandler } from "./comment-reply";
import { privateReplyHandler } from "./private-reply";
import { sendDmHandler } from "./send-dm";
import type { BlockHandler } from "./types";
import { waitForReplyHandler } from "./wait-for-reply";

export * from "./types";

/**
 * Runtime handler of every executable block declared in @app/core. `satisfies` makes a block
 * declared without a handler (or a handler for an unknown block) a compile error.
 */
const blockHandlers = {
  "action.send_dm": sendDmHandler,
  "action.private_reply": privateReplyHandler,
  "action.comment_reply": commentReplyHandler,
  "control.wait_for_reply": waitForReplyHandler,
} satisfies { [T in NodeType]: BlockHandler<T, any, any> };

/** A handler seen through a runtime block type. */
export type AnyBlockHandler = BlockHandler<NodeType, Record<string, unknown>, unknown>;

export const handlerFor = (type: string): AnyBlockHandler | undefined =>
  Object.hasOwn(blockHandlers, type) ? (blockHandlers[type as NodeType] as unknown as AnyBlockHandler) : undefined;
