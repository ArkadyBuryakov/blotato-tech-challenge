import type { BlockConfig, EventOf, GraphNode, NodeType, StepStatus, WaitKind } from "@app/core";
import type { Selectable } from "kysely";
import type { Tx } from "../../db/client";
import type { RunTable } from "../../db/schema";
import type { EngineDeps } from "../deps";

/**
 * Runtime half of a block (the declaration half lives in @app/core). The engine's job
 * primitives (execute-step, route-event, step-timer, step-task) are block-agnostic: they load the
 * step, call the handler, and persist what it returns. Handlers decide; the engine owns
 * transactions, locking, idempotency, retries and scheduling of successors.
 */

export type Run = Selectable<RunTable>;
export type StepState = Record<string, unknown>;

export type StepCtx<T extends NodeType, S extends StepState> = {
  readonly deps: EngineDeps;
  readonly run: Run;
  readonly node: GraphNode;
  readonly config: BlockConfig<T>;
  /** Rendered inputs. `start` may annotate them: they are stored with the step. */
  readonly input: Record<string, string>;
  /** Block-private state of a suspended step (`run_steps.state`). */
  readonly state: S;
};

/** Context inside a transaction that holds the run lock. */
export type TxStepCtx<T extends NodeType, S extends StepState> = StepCtx<T, S> & { readonly trx: Tx };

/** Finish the step and continue the run through `port`. */
export type Completion = {
  readonly kind: "complete";
  readonly port: string;
  readonly output: Record<string, unknown>;
  readonly status?: "succeeded" | "timed_out";
};

export type Outcome<S extends StepState, P> =
  | Completion
  /** Run `perform(plan)` outside any transaction, then complete through `effectPort`. */
  | { readonly kind: "effect"; readonly plan: P }
  /** Become `waiting` until an event (`on`) or the deadline (`onTimer`) resumes the step. */
  | { readonly kind: "suspend"; readonly until: Date; readonly state: S }
  | { readonly kind: "fail"; readonly error: string };

export type StepTask = { readonly name: string; readonly data: Record<string, unknown> };

/** How a suspended step reacts to an event or to its deadline. */
export type Resume<S extends StepState> =
  | Completion
  /** Event consumed, keep waiting (optionally with new state and follow-up tasks). */
  | { readonly kind: "stay"; readonly state?: S; readonly tasks?: readonly StepTask[] }
  /** Event not consumed: it may resume another step or start new runs. */
  | { readonly kind: "ignore" };

export type BlockHandler<T extends NodeType, S extends StepState = StepState, P = unknown> = {
  /** Called by execute-step in the claim transaction (run locked). */
  start(ctx: TxStepCtx<T, S>): Promise<Outcome<S, P>>;
  /** The side effect of an `effect` outcome. Throw a transient MetaApiError to be retried. */
  perform?(deps: EngineDeps, plan: P, run: Run): Promise<Record<string, unknown>>;
  /** Port a successful effect continues through (default `out`). */
  readonly effectPort?: string;
  /** The suspension deadline passed (step-timer). */
  onTimer?(ctx: TxStepCtx<T, S>): Promise<Resume<S>>;
  /** Follow-up side effects requested through `Resume.tasks` (step-task), outside any transaction. */
  readonly tasks?: {
    readonly [name: string]: (ctx: StepCtx<T, S> & { readonly status: StepStatus }, data: Record<string, unknown>) => Promise<void>;
  };
} & ([WaitKind<T>] extends [never]
  ? { readonly on?: never }
  : {
      /** Reaction to an event the block's `wait.matches` (core) routed to this suspended step. */
      on(ctx: TxStepCtx<T, S>, event: EventOf<WaitKind<T>>): Promise<Resume<S>>;
    });
