import { defineEval } from "eve/evals";
import { asOwnerMessage } from "../shared.js";

/**
 * The Resy procedure lives in a skill now, not in the always-on instructions.
 * That trade only holds if the skill actually triggers — and the failure mode
 * when it doesn't is nasty precisely because it isn't loud: she still has every
 * Resy tool mounted, so she'll attempt something. It just won't be governed by
 * any of the rules that moved out of the prompt. From the outside that reads as
 * Lucy being a bit vague, not as a regression.
 *
 * The prompt here is booking-shaped but deliberately DATELESS. That does double
 * duty: it should route to the skill, and the skill's own rule ("a month is not
 * a date and 'sometime next week' is not a date — offer two or three specific
 * nights before creating anything") says the correct response is to come back
 * with candidates rather than to arm anything.
 *
 * Which is also what makes this eval safe to run for real. RESY_AUTO_APPROVE=1
 * is set on this deployment, so the approval card is skipped and a `book_resy`
 * or `snipe_resy` call would go straight through to a genuine reservation
 * against the owner's account and card. The notCalledTool assertions below are
 * gates, never soft: this eval must be incapable of spending his money, and a
 * dateless request is the one booking-shaped prompt where "create nothing" is
 * unambiguously the right answer.
 */
export default defineEval({
  description: "A booking request loads the resy skill and arms nothing without a real date.",
  tags: ["resy"],
  async test(t) {
    const turn = await t.send(
      asOwnerMessage("can you get me into Carbone sometime next month? party of 2"),
    );

    t.succeeded();

    // The point of the eval: the procedure has to be pulled in.
    t.loadedSkill("resy");

    // Nothing may be created off a request with no date on it. Gates, because
    // auto-approve means there is no card standing between a tool call and a
    // real table — see the note above.
    t.notCalledTool("snipe_resy");
    t.notCalledTool("book_resy");
    t.notCalledTool("cancel_resy_booking");

    // Soft: she should resolve the venue herself rather than asking him for an
    // id, and Carbone is ambiguous (Manhattan vs Miami), which is exactly the
    // case the skill tells her to name back. Soft rather than a gate because
    // asking for dates BEFORE looking anything up is also defensible.
    t.calledTool("search_resy", { input: { query: /carbone/i } }).soft();

    t.judge.autoevals.closedQA(
      "The owner asked for a restaurant table 'sometime next month' without naming a date. " +
        "Does the reply ask which night he wants, or offer specific candidate dates, rather " +
        "than claiming a table is booked or that a reservation has been set up? Answer NO if " +
        "it states or implies anything has been reserved, held, or armed.",
      { on: turn.message ?? "" },
    ).atLeast(0.5);
  },
});
