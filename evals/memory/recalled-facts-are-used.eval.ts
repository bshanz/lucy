import { defineEval } from "eve/evals";
import { asOwnerMessage } from "./shared.js";
import { supabase } from "#lib/supabase.js";

/**
 * A fact that is only in long-term memory reaches the model without her having
 * to go and look for it.
 *
 * This is the memory slot (agent/memory.ts) doing its one job: the newest
 * memories are recalled into context before the turn. The old failure was the
 * opposite — a fact sat in the table for days and she answered as if she'd
 * never heard it, because nothing prompted a `recall_memories` call. The row
 * is inserted directly, not via `remember`, so the eval tests recall alone.
 *
 * `notCalledTool("recall_memories")` is the actual gate: getting the name right
 * by searching would pass a weaker test and hide a broken slot.
 */
export default defineEval({
  description: "A fact that lives only in memory is used without a recall_memories call.",
  tags: ["memory"],
  async test(t) {
    const marker = "Okonkwo-Vasquez";
    const { data, error } = await supabase
      .from("memories")
      .insert({ content: `His dentist is Dr. ${marker}, on Hoyt Street in Brooklyn.`, category: "people" })
      .select("id")
      .single();
    if (error) throw new Error(`seed failed: ${error.message}`);
    const id = data.id as string;

    try {
      const turn = await t.send(...asOwnerMessage("what's my dentist's name again?"));
      t.succeeded();
      t.notCalledTool("recall_memories");
      t.notCalledTool("search_email");
      t.judge.autoevals
        .closedQA(`Does the reply name the dentist as Dr. ${marker}?`, { on: turn.message ?? "" })
        .atLeast(0.8);
    } finally {
      const { error: cleanupError } = await supabase.from("memories").delete().eq("id", id);
      t.log(cleanupError ? `cleanup FAILED: ${cleanupError.message}` : "cleanup: removed 1 memory row");
    }
  },
});
