import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import { asOwnerMessage, eraseEvalMemories, type ObservedToolCall } from "./shared.js";

/**
 * When the owner tells her how to behave from now on, it has to reach the
 * database. Agreeing in the reply saves nothing.
 *
 * Observed on 2026-08-22: he said "when I ask you about all reminders I also
 * want to see ones like this", and she answered "Got it — noted. From now on
 * I'll surface everything". No `remember` call. The preference existed only in
 * the session transcript, and the newest row in `memories` was five days old.
 *
 * That was survivable while a conversation window lived thirty days. It is not
 * now: a session running stale channel code rotates after three, so a
 * preference that lives only in the transcript has roughly a three-day
 * half-life. The symptom is Lucy quietly forgetting something he explicitly
 * told her, days later, with nothing to connect it back — and him having to
 * teach her the same thing twice.
 *
 * The prompt carries no fact about his life, no person, no date. The only thing
 * worth keeping in it is an instruction about how she should work, which is
 * exactly the category that was being dropped.
 */
export default defineEval({
  description: "A standing 'from now on' instruction gets written to memory, not just agreed to.",
  tags: ["memory"],
  async test(t) {
    const since = new Date().toISOString();
    let calls: readonly ObservedToolCall[] = [];

    try {
      const turn = await t.send(
        asOwnerMessage(
          "from now on when I ask what my day looks like, lead with anything ferroniere-related first",
        ),
      );
      calls = turn.toolCalls;

      t.succeeded();

      // The gate. Once, and carrying the instruction itself — a memory that
      // records that he stated a preference, without recording which one, is
      // the same failure wearing a tool call.
      t.calledTool("remember", {
        input: { content: /ferroniere/i },
        count: 1,
      });

      // This is a standing instruction, not a thing that happened at a time.
      // Filing it in the diary would put it somewhere nothing reads it back.
      t.notCalledTool("log_moment");
      t.notCalledTool("create_reminder");

      t.calledTool("remember", { input: { category: /preference/i } }).soft();

      // Brief. "Noted" was never the problem — doing only that was.
      t.check(
        turn.message ?? "",
        satisfies(
          (reply: string) => reply.length > 0 && reply.length <= 240,
          "reply is short (<= 240 chars)",
        ),
      );

      t.judge.autoevals.closedQA(
        "Does the reply simply confirm it will do this going forward? Answer NO if it makes a " +
          "production of saving the preference, explains its memory system, or asks follow-up " +
          "questions about the instruction instead of just accepting it.",
        { on: turn.message ?? "" },
      ).atLeast(0.5);
    } finally {
      t.log(await eraseEvalMemories({ calls, since, marker: "ferroniere" }));
    }
  },
});
