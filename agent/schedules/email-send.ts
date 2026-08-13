import { defineSchedule } from "eve/schedules";
import type { ScheduleHandlerArgs } from "eve/schedules";
import sendblue from "#channels/sendblue.js";
import slack from "#channels/slack.js";
import { buildNewEmailRaw, findSentMessage, sendEmail } from "#lib/gmail.js";
import { formatLocal } from "#lib/reminders.js";
import { STUCK_MS, supabase, type ScheduledEmailRow } from "#lib/scheduled-email.js";

/**
 * Sends the emails the owner already approved, at the moment he asked for.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO IS THINK. There is no receive() on the send
 * path and no model in the loop: to_address, subject and body come out of the
 * row exactly as they went in at approval time, through the same
 * buildNewEmailRaw() the interactive tool uses. That is the whole safety
 * argument for skipping the approval card here — not "a cron started this turn",
 * but "nothing between his yes and the wire is capable of composing a different
 * email". A model turn on this path would quietly throw that away.
 *
 * THE CLAIM IS NOT OPTIONAL. Vercel can deliver a cron twice and eve re-runs
 * interrupted steps. Here a re-run mails a real person the same thing twice from
 * the owner's real address. The claim is an UPDATE ... RETURNING gated on
 * `status = 'scheduled'`: the second worker gets zero rows and goes home.
 *
 * A LOST SEND MUST STILL SPEAK. He scheduled it and stopped thinking about it,
 * so silence reads as success. Every branch below texts him, including the ugly
 * one where we genuinely don't know what happened.
 *
 * `eve dev` never fires crons — trigger locally with
 * `curl -X POST http://localhost:3000/eve/v1/dev/schedules/email-send`.
 */

type Receive = ScheduleHandlerArgs["receive"];

async function dispatch(
  receive: Receive,
  appAuth: ScheduleHandlerArgs["appAuth"],
  row: Pick<ScheduledEmailRow, "channel" | "phone" | "slack_target">,
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

const sentPrompt = (row: ScheduledEmailRow) =>
  `An email the owner approved earlier just went out on schedule: to ${row.to_address}, ` +
  `subject "${row.subject}", sent at ${formatLocal(new Date().toISOString())}. Tell him in ` +
  `ONE short line that it went — he already knows what it said, so don't recap the body and ` +
  `don't ask him anything. A quick "sent that to X ✓" is the whole message.`;

const failedPrompt = (row: ScheduledEmailRow, reason: string) =>
  `A scheduled email FAILED to send: to ${row.to_address}, subject "${row.subject}", which was ` +
  `due at ${formatLocal(row.send_at)}. What went wrong: ${reason}. Tell him straight away in ` +
  `one or two lines and offer to try again or to send it now. Do NOT claim it was sent, and do ` +
  `NOT imply it will retry on its own — it won't.`;

const unknownPrompt = (row: ScheduledEmailRow) =>
  `A scheduled email to ${row.to_address}, subject "${row.subject}", was interrupted while ` +
  `sending and I genuinely cannot tell whether it left the mailbox — it isn't in his Sent ` +
  `folder, but the request may still have landed. Tell him exactly that, plainly, in one or ` +
  `two lines: it may or may not have gone, and he should check Sent before resending. Do NOT ` +
  `pick a side, and do NOT resend it yourself.`;

/** Record the outcome first, then speak. A sent email the database doesn't know
 *  about is worse than a missing text: the next tick would send it again. */
async function markSent(row: ScheduledEmailRow, attempts: number): Promise<void> {
  const { error } = await supabase
    .from("scheduled_emails")
    .update({
      status: "sent",
      sent_at: new Date().toISOString(),
      attempts,
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id);
  if (error) console.error(`[email-send] sent but couldn't record it: ${error.message}`);
}

async function markFailed(
  row: ScheduledEmailRow,
  reason: string,
  attempts: number,
): Promise<void> {
  const { error } = await supabase
    .from("scheduled_emails")
    .update({
      status: "failed",
      last_error: reason.slice(0, 500),
      attempts,
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id);
  if (error) console.error(`[email-send] couldn't record failure: ${error.message}`);
}

export default defineSchedule({
  cron: "* * * * *",
  async run({ receive, appAuth }) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
      console.warn("[email-send] Supabase env not set; skipping");
      return;
    }

    // --- 0. Rows orphaned by a crash between the claim and the send.
    //
    // ⚠️ NEVER blindly retry these and never blindly fail them. The POST may have
    // reached Gmail and committed before the invocation died, so a retry mails
    // the person twice and a failure notice tells him his email didn't go when
    // it did — and he acts on that. Ask the mailbox instead. Same discipline as
    // the timed-out /3/book recovery in resy-snipe.ts, for the same reason.
    const { data: stuck } = await supabase
      .from("scheduled_emails")
      .select("*")
      .eq("status", "sending")
      .lt("claimed_at", new Date(Date.now() - STUCK_MS).toISOString())
      .returns<ScheduledEmailRow[]>();

    for (const row of stuck ?? []) {
      let landed: boolean | null = null;
      try {
        landed = await findSentMessage(row.to_address, row.subject);
      } catch (err) {
        console.error(`[email-send] couldn't check Sent for ${row.id}`, err);
      }

      if (landed) {
        console.warn(`[email-send] ${row.id} was interrupted but had already sent`);
        await markSent(row, row.attempts);
        try {
          await dispatch(receive, appAuth, row, sentPrompt(row));
        } catch (err) {
          console.error("[email-send] recovery notice failed", err);
        }
        continue;
      }

      // Not found, or we couldn't look. Either way this is an unknown, not a
      // failure, and the message he gets has to say so.
      await markFailed(row, "interrupted mid-send; not found in Sent", row.attempts);
      try {
        await dispatch(receive, appAuth, row, unknownPrompt(row));
      } catch (err) {
        console.error("[email-send] uncertainty notice failed", err);
      }
    }

    // --- 1. Claim what's due. Status flips inside the same statement that
    // selects, so a duplicate cron delivery comes back with zero rows.
    const { data, error } = await supabase
      .from("scheduled_emails")
      .update({ status: "sending", claimed_at: new Date().toISOString() })
      .eq("status", "scheduled")
      .lte("send_at", new Date().toISOString())
      .select("*")
      .returns<ScheduledEmailRow[]>();
    if (error) throw new Error(`[email-send] claim failed: ${error.message}`);

    const due = data ?? [];
    if (due.length === 0) return;
    console.log(`[email-send] sending ${due.length} email(s)`);

    // Sequential, with the outcome of each isolated: these are ~200ms apiece and
    // one bad recipient must not strand the email queued behind it.
    for (const row of due) {
      const attempts = row.attempts + 1;
      try {
        await sendEmail(
          buildNewEmailRaw({ to: row.to_address, subject: row.subject, text: row.body }),
        );
      } catch (err) {
        // A throw here is ambiguous in exactly the same way an orphan is: a
        // socket that died after the request left looks identical to one that
        // died before. Ask the mailbox before saying anything.
        const reason = err instanceof Error ? err.message : String(err);
        let landed = false;
        try {
          landed = await findSentMessage(row.to_address, row.subject);
        } catch {
          // Fall through as not-landed; the failure notice offers a retry, which
          // is a human decision and the right place for this uncertainty to sit.
        }
        if (!landed) {
          await markFailed(row, reason, attempts);
          try {
            await dispatch(receive, appAuth, row, failedPrompt(row, reason));
          } catch (dispatchErr) {
            console.error("[email-send] failure notice failed", dispatchErr);
          }
          continue;
        }
        console.warn(`[email-send] ${row.id} threw but the email had landed: ${reason}`);
      }

      await markSent(row, attempts);
      try {
        await dispatch(receive, appAuth, row, sentPrompt(row));
      } catch (err) {
        // The email is out and recorded. A missing confirmation text is a
        // nuisance; re-sending the email to fix it would not be.
        console.error("[email-send] sent notice failed", err);
      }
    }
  },
});
