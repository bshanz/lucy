import { defineEval } from "eve/evals";
import { asOwnerMessage } from "./shared.js";

/**
 * Logging is only worth doing if it comes back out. This is the read side, and
 * it's the reason the write side has to be disciplined about dates and bodies.
 *
 * Read-only: no cleanup, and no assertion on the actual number, which depends
 * on what's really in the diary the day this runs. What's gated is that she
 * searched the log at all rather than answering from the conversation — an
 * answer invented from context is the failure that looks most like a success.
 */
export default defineEval({
  description: "A question about the past searches the diary instead of guessing.",
  tags: ["moments"],
  async test(t) {
    const turn = await t.send(asOwnerMessage("how many times have I had ice cream this month?"));

    t.succeeded();
    t.calledTool("recall_moments");

    // A month question should carry a window, not scan the default 30 rows.
    t.calledTool("recall_moments", {
      input: { fromLocal: (value: unknown) => typeof value === "string" && value.length >= 10 },
    }).soft();

    t.judge.autoevals.closedQA(
      "Does the reply give a specific answer about how many times — a number, a count in words, " +
        "or an explicit 'none' — rather than deflecting, asking a clarifying question, or " +
        "saying it cannot know?",
      { on: turn.message ?? "" },
    ).atLeast(0.5);
  },
});
