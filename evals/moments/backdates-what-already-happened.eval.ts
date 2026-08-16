import { defineEval } from "eve/evals";
import { ownerWallClockToUtc } from "#lib/reminders.js";
import { asOwnerMessage, eraseEvalMoments, type ObservedToolCall } from "./shared.js";

/**
 * Half of what makes a diary worth having is that entries sit on the right day.
 * `log_moment` defaults `happened_at` to now, so "went to a show last night"
 * logged without `happenedAtLocal` is not a small error — it's a Tuesday
 * concert filed under Wednesday, and it stays wrong forever.
 *
 * The assertion is deliberately a range rather than an exact timestamp. "Last
 * night" is genuinely fuzzy, and pinning it to 20:00 would make the eval fail
 * on a correct answer. Anything between an hour and a day and a half ago is a
 * real backdate; "now" is the bug.
 */
export default defineEval({
  description: "Something described as already-happened is backdated, not stamped with now.",
  tags: ["moments"],
  async test(t) {
    const since = new Date().toISOString();
    let calls: readonly ObservedToolCall[] = [];

    try {
      const turn = await t.send(asOwnerMessage("forgot to tell you — saw a show at Bowery Ballroom last night, it was great"));
      calls = turn.toolCalls;

      t.succeeded();
      t.calledTool("log_moment", { input: { body: /bowery|show|concert/i }, count: 1 });

      t.calledTool("log_moment", {
        input: {
          // Runs the model's wall-clock string through the same owner-timezone
          // conversion the tool uses, so this tests the value the database
          // would actually receive rather than the string's shape.
          happenedAtLocal: (value: unknown) => {
            if (typeof value !== "string") return false;
            const at = ownerWallClockToUtc(value);
            if (!at) return false;
            const ageMs = Date.now() - at.getTime();
            return ageMs > 60 * 60 * 1000 && ageMs < 36 * 60 * 60 * 1000;
          },
        },
      });
    } finally {
      t.log(await eraseEvalMoments({ calls, since, marker: "Bowery" }));
    }
  },
});
