import { defineSchedule } from "eve/schedules";
import type { ScheduleHandlerArgs } from "eve/schedules";
import sendblue from "#channels/sendblue.js";
import slack from "#channels/slack.js";
import { STUCK_MS, explainSendFailure, supabase, type OutboundTextRow } from "#lib/outbound-text.js";
import { formatLocal } from "#lib/reminders.js";
import { findSentText, sendMessageWithHandle } from "#lib/sendblue.js";

/**
 * Sends the texts the owner already approved, at the moment he asked for.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO IS THINK. There is no receive() on the send
 * path and no model in the loop: to_number and body come out of the row exactly as
 * they went in at approval time. That is the whole safety argument for skipping
 * the approval card here — not "a cron started this turn", but "nothing between
 * his yes and the wire is capable of composing a different message, or addressing
 * it to a different person". A model turn on this path would quietly throw that
 * away, and every schedule in this repo runs a model with untrusted email content
 * in its context.
 *
 * THE CLAIM IS NOT OPTIONAL. Vercel can deliver a cron twice and eve re-runs
 * interrupted steps. Here a re-run texts a real person the same thing twice. The
 * claim is an UPDATE ... RETURNING gated on `status = 'scheduled'`: the second
 * worker gets zero rows and goes home.
 *
 * A LOST SEND MUST STILL SPEAK. He scheduled it and stopped thinking about it, so
 * silence reads as success. Every branch below texts him, including the ugly one
 * where we genuinely don't know what happened.
 *
 * `eve dev` never fires crons — trigger locally with
 * `curl -X POST http://localhost:3000/eve/v1/dev/schedules/text-send`.
 */

type Receive = ScheduleHandlerArgs["receive"];

async function dispatch(
  receive: Receive,
  appAuth: ScheduleHandlerArgs["appAuth"],
  row: Pick<OutboundTextRow, "channel" | "phone" | "slack_target">,
  message: string,
): Promise<void> {
  if (row.channel === "slack" && row.slack_target?.channelId) {
    await receive(slack, {
      message,
      target: { channelId: row.slack_target.channelId },
      auth: appAuth,
    });
    return;
  }
  const phone = row.phone ?? process.env.OWNER_PHONE;
  if (!phone) throw new Error("no delivery target (OWNER_PHONE missing)");
  await receive(sendblue, { message, target: { phone }, auth: appAuth });
}

/** A short quote, so he knows which text without being handed the whole thing back. */
const quote = (row: OutboundTextRow) => `"${row.body.replace(/\s+/g, " ").slice(0, 80)}"`;

const sentPrompt = (row: OutboundTextRow) =>
  `A text the owner approved earlier just went out on schedule: to ${row.to_number}, ` +
  `${quote(row)}, sent at ${formatLocal(new Date().toISOString())}. Tell him in ONE short line ` +
  `that it went — he already knows what it said, so don't recap it and don't ask him anything. ` +
  `A quick "sent that to X ✓" is the whole message.`;

const failedPrompt = (row: OutboundTextRow, reason: string) =>
  `A scheduled text FAILED to send: to ${row.to_number}, ${quote(row)}, which was due at ` +
  `${formatLocal(row.send_at)}. What went wrong: ${reason}. Tell him straight away in one or ` +
  `two lines and offer to try again or to send it now. Do NOT claim it was sent, and do NOT ` +
  `imply it will retry on its own — it won't.`;

const unknownPrompt = (row: OutboundTextRow) =>
  `A scheduled text to ${row.to_number}, ${quote(row)}, was interrupted while sending and I ` +
  `genuinely cannot tell whether it left the line. Tell him exactly that, plainly, in one or ` +
  `two lines: it may or may not have gone, and he should check with them before resending. Do ` +
  `NOT pick a side, and do NOT resend it yourself.`;

/** Record the outcome first, then speak. A sent text the database doesn't know
 *  about is worse than a missing confirmation: the next tick would send it again. */
async function markSent(
  row: OutboundTextRow,
  attempts: number,
  handle: string | null,
): Promise<void> {
  const { error } = await supabase
    .from("outbound_texts")
    .update({
      status: "sent",
      sent_at: new Date().toISOString(),
      message_handle: handle,
      attempts,
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id);
  if (error) console.error(`[text-send] sent but couldn't record it: ${error.message}`);
}

async function markFailed(row: OutboundTextRow, reason: string, attempts: number): Promise<void> {
  const { error } = await supabase
    .from("outbound_texts")
    .update({
      status: "failed",
      last_error: reason.slice(0, 500),
      attempts,
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id);
  if (error) console.error(`[text-send] couldn't record failure: ${error.message}`);
}

export default defineSchedule({
  cron: "* * * * *",
  async run({ receive, appAuth }) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
      console.warn("[text-send] Supabase env not set; skipping");
      return;
    }

    // --- 0. Rows orphaned by a crash between the claim and the send.
    //
    // ⚠️ NEVER blindly retry these and never blindly fail them. The POST may have
    // reached Sendblue and committed before the invocation died, so a retry texts
    // the person twice and a failure notice tells him his message didn't go when
    // it did — and he acts on that. Ask Sendblue instead, the same way email-send
    // asks Gmail and resy-snipe re-reads a timed-out /3/book.
    const { data: stuck } = await supabase
      .from("outbound_texts")
      .select("*")
      .eq("status", "sending")
      .lt("claimed_at", new Date(Date.now() - STUCK_MS).toISOString())
      .returns<OutboundTextRow[]>();

    for (const row of stuck ?? []) {
      let landed: boolean | null = null;
      try {
        landed = await findSentText(row.to_number, row.body);
      } catch (err) {
        console.error(`[text-send] couldn't check sent messages for ${row.id}`, err);
      }

      if (landed) {
        console.warn(`[text-send] ${row.id} was interrupted but had already sent`);
        await markSent(row, row.attempts, row.message_handle);
        try {
          await dispatch(receive, appAuth, row, sentPrompt(row));
        } catch (err) {
          console.error("[text-send] recovery notice failed", err);
        }
        continue;
      }

      // Not found, or we couldn't look. Either way this is an unknown, not a
      // failure, and the message he gets has to say so.
      await markFailed(row, "interrupted mid-send; not found in sent messages", row.attempts);
      try {
        await dispatch(receive, appAuth, row, unknownPrompt(row));
      } catch (err) {
        console.error("[text-send] uncertainty notice failed", err);
      }
    }

    // --- 1. Claim what's due. Status flips inside the same statement that
    // selects, so a duplicate cron delivery comes back with zero rows.
    const { data, error } = await supabase
      .from("outbound_texts")
      .update({ status: "sending", claimed_at: new Date().toISOString() })
      .eq("status", "scheduled")
      .lte("send_at", new Date().toISOString())
      .select("*")
      .returns<OutboundTextRow[]>();
    if (error) throw new Error(`[text-send] claim failed: ${error.message}`);

    const due = data ?? [];
    if (due.length === 0) return;
    console.log(`[text-send] sending ${due.length} text(s)`);

    // Sequential, with the outcome of each isolated: one bad recipient must not
    // strand the text queued behind it.
    for (const row of due) {
      const attempts = row.attempts + 1;
      let handle: string | null = null;
      try {
        handle = await sendMessageWithHandle(row.to_number, row.body, row.media_url);
      } catch (err) {
        // A throw here is ambiguous in exactly the same way an orphan is: a socket
        // that died after the request left looks identical to one that died
        // before. Ask Sendblue before saying anything.
        // Same explainer the interactive tool uses: an unverified recipient is the
        // most likely failure here and the only one with a fix, and at 8am he needs
        // the fix rather than a status code.
        const reason = explainSendFailure(err, row.to_number);
        let landed = false;
        try {
          landed = await findSentText(row.to_number, row.body);
        } catch {
          // Fall through as not-landed; the failure notice offers a retry, which
          // is a human decision and the right place for this uncertainty to sit.
        }
        if (!landed) {
          await markFailed(row, reason, attempts);
          try {
            await dispatch(receive, appAuth, row, failedPrompt(row, reason));
          } catch (dispatchErr) {
            console.error("[text-send] failure notice failed", dispatchErr);
          }
          continue;
        }
        console.warn(`[text-send] ${row.id} threw but the text had landed: ${reason}`);
      }

      await markSent(row, attempts, handle);
      try {
        await dispatch(receive, appAuth, row, sentPrompt(row));
      } catch (err) {
        // The text is out and recorded. A missing confirmation is a nuisance;
        // re-sending the text to fix it would not be.
        console.error("[text-send] sent notice failed", err);
      }
    }
  },
});
