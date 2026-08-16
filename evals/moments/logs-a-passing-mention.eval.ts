import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import { asOwnerMessage, eraseEvalMoments, type ObservedToolCall } from "./shared.js";

/**
 * The core of the diary: he mentions eating something in passing, and it lands
 * in the log without him asking and without a conversation about it.
 *
 * Two failures this catches, and they pull in opposite directions:
 *  - She doesn't log at all, because nobody told her to. The diary silently
 *    stops being a record of anything.
 *  - She logs, then makes the logging the topic ("I've saved that to your
 *    diary under Food! Would you like me to..."). Behaviourally correct,
 *    conversationally intolerable, and the reason he'd stop mentioning things.
 */
export default defineEval({
  description: "A passing mention of ice cream gets logged, unprompted and without ceremony.",
  tags: ["moments"],
  async test(t) {
    const since = new Date().toISOString();
    let calls: readonly ObservedToolCall[] = [];

    try {
      const turn = await t.send(asOwnerMessage("just had a scoop of pistachio at Morgenstern's, so good"));
      calls = turn.toolCalls;

      t.succeeded();

      // Gate: it was logged, once, with what he actually said in it.
      t.calledTool("log_moment", {
        input: { body: /pistachio|morgenstern/i },
        count: 1,
      });

      // `category` is optional in the tool schema, so this is a metric, not a
      // gate — a categorised moment recalls better, but an uncategorised one is
      // still a logged one.
      t.calledTool("log_moment", { input: { category: "food" } }).soft();

      // Nothing else should fire off a dessert. In particular this is not a
      // durable fact about him, so it isn't `remember`'s job.
      t.notCalledTool("remember");
      t.notCalledTool("create_reminder");

      // Quiet. He mentioned ice cream; a paragraph back is the failure mode.
      t.check(
        turn.message ?? "",
        satisfies((reply: string) => reply.length > 0 && reply.length <= 220, "reply is short (<= 220 chars)"),
      );

      t.judge.autoevals.closedQA(
        "Does the reply respond to the ice cream the way a friend texting back would, " +
          "without making the act of recording or saving it the subject of the message? " +
          "A brief acknowledgement like 'logged' is fine; explaining that it was saved, " +
          "asking follow-up questions about the record, or offering diary features is not.",
        { on: turn.message ?? "" },
      ).atLeast(0.5);
    } finally {
      t.log(await eraseEvalMoments({ calls, since, marker: "Morgenstern" }));
    }
  },
});
