import { stepStatuses, type StepStatus } from "@app/core";

export const StatusBadge = ({ status }: { status: string }) => <span className={`badge badge-${status}`}>{status.replace("_", " ")}</span>;

/** One badge per step status present in the run: `{status: count}`. */
export const CounterBadges = ({ counters }: { counters: Partial<Record<StepStatus, number>> }) => (
  <span className="row" style={{ gap: 4 }}>
    {stepStatuses
      .filter((s) => counters[s])
      .map((s) => (
        <span key={s} className={`badge badge-${s}`} title={s}>
          {s.replace("_", " ")} · {counters[s]}
        </span>
      ))}
  </span>
);
