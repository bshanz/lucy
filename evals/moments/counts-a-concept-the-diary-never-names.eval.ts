import { defineEval } from "eve/evals";
import { supabase } from "#lib/supabase.js";
import { asOwnerMessage, eraseEvalMoments, type ObservedToolCall } from "./shared.js";

/**
 * The diary stores his words; questions arrive in categories. Nothing bridges
 * the two automatically, and when that gap opened it produced the worst kind of
 * failure this assistant has: a confident, specific, false statement about his
 * own life.
 *
 * 2026-08-22, verbatim — "How many drinks have I had this month" → "Nothing
 * logged for drinks this month yet." There were four entries and nine drinks in
 * the table. `recall_moments` had done a literal `ilike '%drinks%'`, and not one
 * body contains that word: they say "2 dirty martinis", "three Bellinis and an
 * espresso martini". The tool answered a question about VOCABULARY and the
 * answer was reported to him as a fact about REALITY.
 *
 * This seeds one entry whose wording deliberately avoids every obvious query
 * term, then asks the concept question. It does not care HOW she bridges the
 * gap — a keyword list, a bare window scan, or the tool's own empty-match
 * fallback are all fine — only that she never again answers "none" over a
 * diary that isn't empty. That is the assertion, and it is a gate: a wrong
 * count is a bug, but "nothing logged" is the one that makes the diary
 * worthless, because it teaches him it isn't recording.
 */
export default defineEval({
  description: "A category question ('how many drinks?') finds entries the diary never calls drinks.",
  tags: ["moments"],
  async test(t) {
    const since = new Date().toISOString();
    let calls: readonly ObservedToolCall[] = [];
    let seededId: string | null = null;

    try {
      // Wording chosen so the obvious searches ("drink", "alcohol", "cocktail")
      // all miss it. "Negroni" is the only handle, and he never said that word.
      const { data, error } = await supabase
        .from("moments")
        .insert({ body: "Had a negroni at Dante", category: "food" })
        .select("id")
        .single();
      if (error) throw new Error(`seed failed: ${error.message}`);
      seededId = data.id as string;

      const turn = await t.send(asOwnerMessage("how many alcoholic drinks have I had this month?"));
      calls = turn.toolCalls;

      t.succeeded();

      // She has to consult the diary at all. An answer from conversational
      // memory is the failure that looks most like a success.
      t.calledTool("recall_moments");

      // Soft, not a gate: the `diary-recall` skill is where the procedure for
      // this lives, so loading it is the intended route. But the eval is about
      // the answer, and reaching a correct one without the skill is a pass —
      // gating here would fail a right answer for taking a different path.
      t.loadedSkill("diary-recall").soft();

      // The gate. Phrased against the reply rather than the tool call because
      // the bug was never in the query — it was in what got said afterwards.
      t.judge.autoevals.closedQA(
        "The owner's diary definitely contains at least one alcoholic drink logged this month. " +
          "Does the reply acknowledge that one or more drinks are logged — a number, a list, or " +
          "a description of them? Answer NO if it claims nothing is logged, that it found no " +
          "drinks, that the diary is empty for this month, or that he hasn't had any.",
        { on: turn.message ?? "" },
      ).atLeast(0.5);

      // Soft: the useful version of this answer names what it counted, so he
      // can correct a miscount. A bare number is right but not yet helpful.
      t.judge.autoevals.closedQA(
        "Does the reply mention at least one specific drink or occasion it counted " +
          "(for example a negroni, a martini, or a particular day), rather than only a bare total?",
        { on: turn.message ?? "" },
      ).atLeast(0.5).soft();
    } finally {
      if (seededId) {
        await supabase.from("moments").delete().eq("id", seededId);
      }
      // Sweep anything the turn itself wrote, plus the seed if the delete above
      // was skipped by a throw before the id came back.
      t.log(await eraseEvalMoments({ calls, since, marker: "Dante" }));
    }
  },
});
