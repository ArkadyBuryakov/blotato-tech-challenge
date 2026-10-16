/**
 * Run status rules. Pure, like the block declarations, so the tricky parts are testable
 * without Postgres or Meta.
 */

export const stepStatuses = [
  "pending",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "timed_out",
  "skipped",
] as const;
export type StepStatus = (typeof stepStatuses)[number];
export type RunStatus = "running" | "waiting" | "succeeded" | "failed";

const ACTIVE: readonly StepStatus[] = ["pending", "running"];

export const deriveRunStatus = (statuses: readonly StepStatus[]): RunStatus =>
  statuses.some((s) => ACTIVE.includes(s))
    ? "running"
    : statuses.includes("waiting")
      ? "waiting"
      : statuses.includes("failed")
        ? "failed"
        : "succeeded";

export const statusCounters = (statuses: readonly StepStatus[]): Partial<Record<StepStatus, number>> =>
  statuses.reduce<Partial<Record<StepStatus, number>>>((acc, s) => ({ ...acc, [s]: (acc[s] ?? 0) + 1 }), {});
