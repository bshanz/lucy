import { defineEval } from "eve/evals";
import { asOwnerMessage, eraseEvalMoments, type ObservedToolCall } from "./shared.js";

/**
 * The counterweight to "log generously".
 *
 * An instruction to log without being asked, read too eagerly, turns every
 * mention of food into an entry — including things he only thought about doing.
 * That failure is invisible in isolation (one plausible-looking row) and fatal
 * in aggregate: the diary stops describing his life and starts describing his
 * intentions, and every count he asks for is inflated.
 *
 * A moment is something that HAPPENED. "Might grab some later" hasn't.
 */
export default defineEval({
  description: "An intention is not a moment — a plan for later doesn't get logged as done.",
  tags: ["moments"],
  async test(t) {
    const since = new Date().toISOString();
    let calls: readonly ObservedToolCall[] = [];

    try {
      const turn = await t.send(asOwnerMessage("might grab a scoop of gelato after dinner tonight if I'm still up"));
      calls = turn.toolCalls;

      t.succeeded();
      t.notCalledTool("log_moment");

      // Nor is a maybe a commitment worth scheduling against.
      t.notCalledTool("create_reminder");
      t.notCalledTool("add_task");
    } finally {
      // Nothing should have been written; if something was, this is what keeps
      // a failing eval from leaving the failure behind in the real diary.
      t.log(await eraseEvalMoments({ calls, since, marker: "gelato" }));
    }
  },
});
