import { ownerTimeContext } from "#lib/reminders.js";

/**
 * A turn shaped the way a real one arrives.
 *
 * The eval driver talks to the HTTP surface directly, which bypasses channel
 * ingress — so without this the agent is handed a message with no clock, which
 * is a situation the owner can never actually produce. An eval that skips it
 * doesn't test production, it tests a harness artifact: she goes and runs
 * `date` in a sandbox, and the eval scores behaviour nobody will ever see.
 * Same helper the sendblue and slack channels use, so drift is impossible.
 *
 * Lives here rather than in one suite's `shared.ts` because every suite needs
 * it — the flights evals ask about "Thursday" and are meaningless without a
 * clock, exactly like the moments evals asking about "last night".
 */
export function asOwnerMessage(text: string): { message: string; clientContext: string[] } {
  return { message: text, clientContext: ownerTimeContext() };
}

/** The shape we need off an eval-observed tool call; matches `EveEvalToolCall`. */
export interface ObservedToolCall {
  readonly name: string;
  readonly output: unknown;
}
