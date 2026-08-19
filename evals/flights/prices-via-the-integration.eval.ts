import { defineEval } from "eve/evals";
import { asOwnerMessage } from "../shared.js";
import { reportFlightSpend } from "./shared.js";

/**
 * The core routing rule: a price question goes through `search_flights`, even
 * when the owner names a website out loud.
 *
 * The prompt is deliberately the most inviting phrasing there is — it says
 * "Google Flights" and "just look up", which is an open invitation to reach for
 * `browser__navigate` or `web_search`. Both are mounted, both are free, and
 * `search_flights` announces itself as metered with a hard daily ceiling, so
 * the cheap-looking answer is the wrong one.
 *
 * What browsing costs, and why this is a gate rather than a preference: a fare
 * scraped off a page carries no `priceRead` (Google's typical range is the only
 * thing that makes a bare number mean anything here), never increments the
 * quota counter, can't be turned into a watch, and reads in an iMessage exactly
 * like a real one. That last part is why it has to fail loudly in CI instead of
 * quietly in production.
 */
export default defineEval({
  description: "A price question routes to search_flights even when the owner names Google Flights.",
  tags: ["flights"],
  async test(t) {
    try {
      const turn = await t.send(
        asOwnerMessage(
          "can you just look up flights from New York to Lisbon on Google Flights for me — Oct 6 out, Oct 13 back",
        ),
      );

      t.succeeded();

      // Gate: the integration answered, once. `count: 1` also pins the
      // "one search per question" budget rule — a fan-out across dates is a
      // different failure with the same green checkmark otherwise.
      t.calledTool("search_flights", { input: { to: /LIS/i }, count: 1 });

      // The whole point of the rule. None of the free, unmetered, unverifiable
      // paths may fire on a flight price question.
      t.notCalledTool("browser__navigate");
      t.notCalledTool("browser__read");
      t.notCalledTool("web_search");
      t.notCalledTool("web_fetch");

      // She translates "New York" herself rather than asking for a code.
      t.calledTool("search_flights", { input: { from: /JFK|EWR|LGA/i } }).soft();

      // Scores only what the gates above cannot see: the shape of the answer.
      // Deliberately does NOT ask the judge whether she browsed — the
      // notCalledTool gates settle that, and asking a judge to re-adjudicate it
      // costs a false negative. The first draft of this question penalised
      // "claiming to have looked at a website", which a correct reply trips the
      // moment it cites Google's typical range — something the Flights section
      // explicitly requires.
      t.judge.autoevals.closedQA(
        "Does the reply state a specific fare and name the airports it checked, without " +
          "asking the owner which airport he means? Citing Google or Google Flights as the " +
          "source of the price is expected and correct, not a problem.",
        { on: turn.message ?? "" },
      ).atLeast(0.5);
    } finally {
      t.log(await reportFlightSpend());
    }
  },
});
