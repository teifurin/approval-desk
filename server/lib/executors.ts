import type { ActionType } from "../../shared/approval.js";

export interface ExecutionInput {
  id: string;
  actionType: ActionType;
  title: string;
  amountCents: number | null;
  payload: Record<string, unknown>;
}

export interface ExecutionResult extends Record<string, unknown> {
  executor: string;
  simulated: boolean;
  receipt: string;
  message: string;
}

const EXECUTORS: Record<ActionType, { name: string; verb: string }> = {
  purchase: { name: "fake-purchase", verb: "Simulated purchase of" },
  external_email: { name: "fake-email", verb: "Simulated sending" },
  shell_command: { name: "shell-dryrun", verb: "Dry run of" },
  merge_pr: { name: "fake-merge", verb: "Simulated merge of" },
  delete_file: { name: "fake-delete", verb: "Simulated deletion of" },
  other: { name: "fake-action", verb: "Simulated" },
};

/**
 * Every executor is a mock: Approval Desk records what would have happened and
 * never spends money, sends mail, or runs a command. It only ever receives the
 * approved request, never new arguments from the caller.
 */
export function runMockExecutor(input: ExecutionInput): ExecutionResult {
  const { name, verb } = EXECUTORS[input.actionType];
  const amount =
    input.amountCents === null
      ? ""
      : ` for $${(input.amountCents / 100).toFixed(2)}`;
  return {
    executor: name,
    simulated: true,
    receipt: `MOCK-${input.id.slice(0, 8).toUpperCase()}`,
    message: `${verb} "${input.title}"${amount}. Nothing real happened.`,
  };
}

/**
 * The approval was used by the agent that asked, which runs the action itself.
 * Approval Desk only records the handoff and can't confirm what happened next.
 */
export function recordHandoff(input: ExecutionInput): ExecutionResult {
  return {
    executor: "caller",
    simulated: false,
    receipt: `USED-${input.id.slice(0, 8).toUpperCase()}`,
    message: `Handed to the agent that asked, which runs "${input.title}" itself.`,
  };
}
