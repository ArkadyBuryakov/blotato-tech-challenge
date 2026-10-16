import type { z } from "zod";
import type { EventKind, InboundEvent } from "../events";
import type { GraphNode } from "../graph";
import { registry } from "../registry";
import { commentReply } from "./comment-reply";
import { commentTrigger } from "./comment-trigger";
import type { BlockDefinition, UserData } from "./define";
import { dmTrigger } from "./dm-trigger";
import { sendDm } from "./send-dm";
import { waitForReply } from "./wait-for-reply";

export * from "./define";
export { publicationsSchema, type Publications } from "./comment-trigger";
export { chooseDelivery, type Delivery } from "./send-dm";
export { evaluateReply, waitTimeoutMs, type ReplyDecision, type WaitConfig } from "./wait-for-reply";

/**
 * Block catalog: the single source of truth for what an automation graph can contain.
 * Add a block by declaring it (`defineBlock`) and listing it here; the server then requires a
 * handler for it (see apps/server/src/engine/blocks).
 */
export const blockSpecs = registry("type", commentTrigger, dmTrigger, sendDm, commentReply, waitForReply);

type Specs = typeof blockSpecs;
export type BlockType = keyof Specs;
export type TriggerType = { [T in BlockType]: Specs[T]["kind"] extends "trigger" ? T : never }[BlockType];
/** Blocks executed as run steps (everything but triggers). */
export type NodeType = Exclude<BlockType, TriggerType>;
export type BlockConfig<T extends BlockType> = z.output<Specs[T]["config"]>;

export const blockTypes = Object.keys(blockSpecs) as BlockType[];
export const blockCatalog: Readonly<Record<BlockType, BlockDefinition>> = blockSpecs;

export const isBlockType = (t: string): t is BlockType => Object.hasOwn(blockSpecs, t);
export const isTriggerType = (t: string): t is TriggerType => isBlockType(t) && blockSpecs[t].kind === "trigger";

/** Parses config with defaults applied. Assumes the graph was validated. */
export const parseConfig = <T extends BlockType>(type: T, config: unknown): BlockConfig<T> =>
  blockSpecs[type].config.parse(config) as BlockConfig<T>;

/** What a block added in the editor starts with. */
export const blockDefaults = (type: BlockType): { config: Record<string, unknown>; inputs: Record<string, string> } => {
  const spec: (typeof blockSpecs)[BlockType] = blockSpecs[type];
  return {
    config: spec.config.parse(spec.defaultConfig ?? {}) as Record<string, unknown>,
    inputs: Object.fromEntries(spec.inputFields.map((f) => [f.key, ""])),
  };
};

// ---------- triggers ----------

/** A trigger declaration seen through a runtime event kind. */
type AnyTrigger = {
  readonly on: EventKind;
  readonly matches: (config: unknown, event: InboundEvent) => boolean;
  readonly output: (event: InboundEvent, user: Partial<UserData>) => Record<string, unknown>;
};

const triggerOf = (type: string): AnyTrigger | undefined =>
  isBlockType(type) ? (blockSpecs[type].trigger as AnyTrigger | undefined) : undefined;

export const triggerMatches = (node: GraphNode, event: InboundEvent): boolean => {
  const t = triggerOf(node.type);
  return !!t && t.on === event.kind && t.matches(parseConfig(node.type as BlockType, node.config), event);
};

/** Output of a matched trigger's step. */
export const triggerOutput = (node: GraphNode, event: InboundEvent, user: Partial<UserData>): Record<string, unknown> =>
  triggerOf(node.type)!.output(event, user);
