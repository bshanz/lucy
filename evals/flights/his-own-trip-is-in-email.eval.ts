import { defineEval } from "eve/evals";
import { asOwnerMessage } from "../shared.js";

/**
 * The carve-out, in the direction that costs nothing to test.
 *
 * "What time is my flight?" is a question about a booking he already holds, and
 * the flight tools cannot answer it — `search_flights` prices a *route* and has
 * no idea what he bought. The failure this catches is her reaching for the
 * integration anyway because the word "flight" is in the sentence: that burns a
 * metered search and returns a number that has nothing to do with his trip.
 *
 * The positive expectation is soft on purpose. The rule points at
 * `search_email`, but checking `list_calendar_events` first and finding the
 * itinerary there is also a correct way to answer — gating on `search_email`
 * would fail her for doing something reasonable. What must hold, and what this
 * eval actually defends, is that she consults his own records and not the
 * market or the open web.
 */
export default defineEval({
  description: "A question about his own booking goes to his records, never to search_flights.",
  tags: ["flights"],
  async test(t) {
    const turn = await t.send(asOwnerMessage("what time is my flight on Thursday?"));

    t.succeeded();

    // Gates: the market has no answer to this, and neither does a web page.
    t.notCalledTool("search_flights");
    t.notCalledTool("track_flight");
    t.notCalledTool("browser__navigate");
    t.notCalledTool("web_search");
    t.notCalledTool("web_fetch");

    // The expected path, recorded as a metric rather than a gate — see above.
    t.calledTool("search_email").soft();

    t.judge.autoevals.closedQA(
      "Does the reply answer from the owner's own records — his email or his calendar — or " +
        "say plainly that it couldn't find the booking there? Quoting a market fare, or " +
        "describing what flights on that route generally cost, does not count.",
      { on: turn.message ?? "" },
    ).atLeast(0.5);
  },
});
