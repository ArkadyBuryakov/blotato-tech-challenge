import { evaluateReply, waitTimeoutMs } from "@app/core";
import type { BlockHandler } from "./types";

/**
 * Suspends the run until the contact answers by DM (`received`) or the deadline passes
 * (`timeout`). Invalid replies are consumed (they never start other automations) and may be
 * answered with a re-ask, sent as a follow-up task so no network call happens under the run lock.
 */
export const waitForReplyHandler: BlockHandler<"control.wait_for_reply", { retries?: number }> = {
  async start({ deps, run, config, input }) {
    if (input.user_id !== run.contact_id) return { kind: "fail", error: "Can only wait for a reply from the person who triggered the run" };
    return { kind: "suspend", until: new Date(deps.now().getTime() + waitTimeoutMs(config)), state: { retries: 0 } };
  },
  on: {
    async message({ config, state }, reply) {
      const retries = state.retries ?? 0;
      const decision = evaluateReply(config, reply, retries);
      if (decision.kind === "accept") return { kind: "complete", port: "received", output: decision.output };
      if (decision.kind === "retry")
        return { kind: "stay", state: { retries: retries + 1 }, tasks: [{ name: "send-retry", data: { retry: retries + 1 } }] };
      return { kind: "stay" };
    },
  },
  async onTimer() {
    return { kind: "complete", port: "timeout", output: {}, status: "timed_out" };
  },
  tasks: {
    // Stale jobs (the step moved on, or a newer re-ask was requested) send nothing.
    "send-retry": async ({ deps, run, config, state, status }, data) => {
      if (status !== "waiting" || state.retries !== data.retry) return;
      await deps.ig.sendMessage(await deps.tokens.get(run.ig_account_id), { id: run.contact_id }, config.retryMessage);
    },
  },
};
