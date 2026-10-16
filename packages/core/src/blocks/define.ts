import { z } from "zod";
import type { EventKind, EventOf } from "../events";

/**
 * A block is declared once, here in core: schema, editor metadata and (for triggers) which
 * event starts it. Shared by the API (validation), the worker (execution) and the web app
 * (editor UI). The server pairs every non-trigger block with a runtime handler.
 *
 * - `config` holds static values (triggers may only have static config).
 * - `inputs` are templated strings (`{{nodeId.path}}`) resolved at run time from upstream outputs.
 * - `outputs` lists the variables a block exposes to downstream blocks.
 * - `ports` are the named outgoing connection points (most blocks have a single `out`).
 * - `wait` (blocks that suspend) declares which events a waiting step of the block consumes.
 */

export type BlockKind = "trigger" | "action" | "control";

export type UserData = { user_id: string; username: string; full_name: string };

export type TriggerSpec<C, K extends EventKind = EventKind> = {
  /** The event kind that starts a run. */
  readonly on: K;
  readonly matches: (config: C, event: EventOf<K>) => boolean;
  /** Output of the trigger step: the variables the whole run can reference. */
  readonly output: (event: EventOf<K>, user: Partial<UserData>) => Record<string, unknown>;
};

export type WaitSpec<C, I, K extends EventKind = EventKind> = {
  /** The event kind a waiting step consumes. */
  readonly on: K;
  /** Whether the event is for this waiting step, judged from its config and rendered inputs. */
  readonly matches: (step: { readonly config: C; readonly input: I }, event: EventOf<K>) => boolean;
};

/** Editor-facing part of a block (no schemas): what the web app renders. */
export type BlockDefinition = {
  readonly type: string;
  readonly kind: BlockKind;
  readonly label: string;
  readonly description: string;
  /** Output variable paths available to downstream blocks. */
  readonly outputs: readonly string[];
  readonly ports: readonly string[];
  /** Input fields shown in the editor (templated strings). */
  readonly inputFields: readonly { key: string; label: string; multiline?: boolean }[];
};

export type BlockSpec<
  T extends string = string,
  K extends BlockKind = BlockKind,
  C extends z.ZodType = z.ZodType,
  I extends z.ZodType = z.ZodType,
  W extends EventKind = never,
> = BlockDefinition & {
  readonly type: T;
  readonly kind: K;
  readonly config: C;
  readonly inputs: I;
  /** Config a freshly added block starts with (schema defaults fill the rest). */
  readonly defaultConfig?: z.input<C>;
  /** Present exactly on `kind: "trigger"` blocks. */
  readonly trigger?: { [E in EventKind]: TriggerSpec<z.output<C>, E> }[EventKind];
  /** Present on blocks whose handler suspends; `W` is the event kind it waits for. */
  readonly wait?: WaitSpec<z.output<C>, z.output<I>, W>;
};

export const defineBlock = <T extends string, K extends BlockKind, C extends z.ZodType, I extends z.ZodType, W extends EventKind = never>(
  spec: BlockSpec<T, K, C, I, W>,
): BlockSpec<T, K, C, I, W> => spec;

export const templated = (label: string) => z.string().trim().min(1, `${label} is required`);

export const userDataOutputs = ["user_data.user_id", "user_data.username", "user_data.full_name"] as const;
