import { defineEval } from "eve/evals";
import { asOwnerMessage } from "../shared.js";

/**
 * The scheduled-email procedure moved into a skill; this checks it still gets
 * pulled in when he asks for a send at a future time.
 *
 * The first version of this eval asked "what emails do I have queued?" and
 * gated on the skill loading. It failed, and it deserved to: she answered
 * correctly straight from `list_scheduled_emails` without the skill, because a
 * read-only queue question doesn't need the procedure. Gating there demanded
 * ceremony rather than behaviour. The scheduling path is where the skill's
 * rules actually decide the outcome — schedule_email over send_email, the card
 * as the whole authorization, saying the time back in words — so that is what
 * this asks for.
 *
 * Safe to run for real despite reaching a live Gmail account: `schedule_email`
 * and `send_email` are both approval-gated with `always()`, so eve raises an
 * input request BEFORE either executes. Nothing is written to the queue and
 * nothing is sent; the run simply parks with an approval nobody answers. That
 * is also why there is no t.succeeded() — parking is the expected end state
 * here, and asserting success would fail the correct outcome.
 *
 * Untested, and worth saying: the drafting rules themselves — final body before
 * the card, never resend on your own, cancel-and-reschedule rather than edit.
 */
export default defineEval({
  description: "A future-dated send loads the scheduled-email skill and never sends now.",
  tags: ["email"],
  async test(t) {
    // The address is given outright on purpose. Naming the recipient only by
    // description ("the pool company") sent the whole turn into search_email /
    // read_email hunting for it, and the scheduling decision never came up —
    // reasonable behaviour that tells us nothing about routing. Handing over
    // the address puts the send in the same turn as the request, which is the
    // thing under test. Nothing can leave regardless: both send tools are
    // approval-gated, and this run never approves.
    const turn = await t.send(
      asOwnerMessage(
        "can you email frontdesk@clearwaterpools.com tomorrow at 9am and let them know " +
          "we'll be away all next week so they should skip the Tuesday service",
      ),
    );

    // The point of the eval.
    t.loadedSkill("scheduled-email");

    // "Tomorrow at 9am" must never become a send-now. A gate, because this is
    // the distinction the skill exists to preserve, and getting it wrong puts
    // mail in a real stranger's inbox a day early.
    t.notCalledTool("send_email");

    // Conversational shape is soft throughout: she may draft and raise the
    // approval card, or come back asking what exactly to say first. Both are
    // correct, and only one of them leaves a message to score.
    t.judge.autoevals.closedQA(
      "Does the reply either propose an email to send at the stated future time — showing " +
        "recipient, content and when it goes — or ask what the message should say? Answer NO " +
        "if it claims the email has already been sent.",
      { on: turn.message ?? "" },
    ).atLeast(0.5).soft();
  },
});
