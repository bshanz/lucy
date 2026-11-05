import { defineEval } from "eve/evals";
import { supabase } from "#lib/supabase.js";
import { asOwnerMessage, type ObservedToolCall } from "../shared.js";

/**
 * "When I get home" is a place, not a time. The failure this guards against is
 * quiet: a model can pick 6pm because people usually get home around then,
 * confirm it warmly, and the reminder fires while he's still at work. So the
 * gate is the shape of the call, not the wording of the reply.
 */
export default defineEval({
  description: "A 'when I get home' reminder is created with a place trigger and no time.",
  tags: ["reminders", "location"],
  async test(t) {
    let calls: readonly ObservedToolCall[] = [];
    try {
      const turn = await t.send(...asOwnerMessage("remind me to take the trash out when I get home"));
      calls = turn.toolCalls;

      t.calledTool("create_reminder", { input: { place: /home/i, on: "arrive" } });
      t.judge.autoevals.closedQA(
        "The owner asked to be reminded when he gets home. Does the reply confirm a reminder " +
          "tied to getting home, WITHOUT claiming a specific clock time for it?",
        { on: turn.message ?? "" },
      ).atLeast(0.5).soft();
    } finally {
      // This writes a real reminder; never leave it armed on his account.
      const ids = calls
        .filter((c) => c.name === "create_reminder")
        .map((c) => (c.output as { id?: string } | null)?.id)
        .filter((id): id is string => !!id);
      if (ids.length) await supabase.from("reminders").delete().in("id", ids);
      t.log(`cleaned up ${ids.length} reminder(s)`);
    }
  },
});
