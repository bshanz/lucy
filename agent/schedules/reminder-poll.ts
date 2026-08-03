import { defineSchedule } from "eve/schedules";
import sendblue from "#channels/sendblue.js";
import slack from "#channels/slack.js";
import {
  MAX_FOLLOW_UPS,
  nextFollowUpAt,
  nextOccurrence,
  supabase,
  type ReminderRow,
} from "#lib/reminders.js";

/**
 * Delivers due reminders, then runs the follow-up pass: a one-off reminder the
 * owner never confirmed gets up to three nudges on a widening curve (a day,
 * three days, a week) before lapsing. Recurring reminders never get nudges —
 * they re-fire on their own.
 *
 * Claim rows atomically before dispatch; on failure roll back so the next
 * tick retries — interrupted schedule steps re-run, so the claim is what
 * prevents double sends.
 */

/** Rough elapsed time in the register a person would use out loud. */
function describeElapsed(ms: number): string {
  const days = Math.round(ms / 86400_000);
  if (days <= 1) return "about a day";
  if (days < 7) return `${days} days`;
  const weeks = Math.round(days / 7);
  return weeks === 1 ? "about a week" : `about ${weeks} weeks`;
}

/**
 * Three nudges in three registers. The same sentence three times is what makes
 * an assistant read like a cron job. The last one says it's the last, out loud:
 * that's what turns the ensuing silence into the owner's answer rather than
 * something that quietly stopped happening behind his back.
 */
function followUpPrompt(reminder: ReminderRow, attempt: number): string {
  // Measured, not assumed: a nudge is only nominally 1/3/7 days out. The clamp
  // into waking hours shifts it, a cron outage shifts it more, and a reminder
  // migrated onto the curve mid-flight can skip an offset entirely. Telling him
  // "it's been about a day" about something four days old is a small lie that
  // makes the whole message read as canned.
  const elapsed = reminder.sent_at
    ? describeElapsed(Date.now() - Date.parse(reminder.sent_at))
    : "a while";
  const tone =
    attempt === 1
      ? `It's been ${elapsed}. Ask casually whether he got to it.`
      : attempt === 2
        ? `It's been ${elapsed} and you've asked once already. Ask once more, lightly, ` +
          "and offer him the out: name a specific day to push it to, or drop it."
        : `It's been ${elapsed} and this is your LAST nudge — say so plainly and warmly ` +
          "(something like 'last time I'll bug you about this'). Tell him it stays on his " +
          "list either way, you just won't keep bringing it up.";
  return (
    `Follow-up check on a reminder the owner hasn't confirmed: "${reminder.body}" ` +
    `(reminder id ${reminder.id}). ${tone} If he did it, call complete_reminder; if he wants ` +
    `more time, reschedule_reminder; if he says drop it, cancel_reminder.`
  );
}

export default defineSchedule({
  cron: "* * * * *",
  async run({ receive, appAuth }) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
      console.warn("[reminder-poll] Supabase env not set; skipping");
      return;
    }

    const { data, error } = await supabase
      .from("reminders")
      .update({ status: "sending" })
      .eq("status", "pending")
      .lte("fire_at", new Date().toISOString())
      .select("*");
    if (error) throw new Error(`[reminder-poll] claim failed: ${error.message}`);

    const due = (data ?? []) as ReminderRow[];
    if (due.length === 0) return;
    console.log(`[reminder-poll] delivering ${due.length} reminder(s)`);

    for (const reminder of due) {
      const prompt =
        `A reminder the owner scheduled earlier is due now: "${reminder.body}". ` +
        `Deliver it to him as a short, natural reminder message.`;
      try {
        if (reminder.channel === "slack" && reminder.slack_target?.channelId) {
          await receive(slack, {
            message: prompt,
            target: { channelId: reminder.slack_target.channelId },
            auth: appAuth,
          });
        } else if (reminder.phone) {
          await receive(sendblue, {
            message: prompt,
            target: { phone: reminder.phone },
            auth: appAuth,
          });
        } else {
          console.error(`[reminder-poll] reminder ${reminder.id} has no valid target; cancelling`);
          await supabase.from("reminders").update({ status: "cancelled" }).eq("id", reminder.id);
          continue;
        }

        if (reminder.recurrence) {
          await supabase
            .from("reminders")
            .update({
              status: "pending",
              fire_at: nextOccurrence(reminder.fire_at, reminder.recurrence),
              sent_at: new Date().toISOString(),
            })
            .eq("id", reminder.id);
        } else {
          const sentAt = new Date().toISOString();
          await supabase
            .from("reminders")
            .update({
              status: "sent",
              sent_at: sentAt,
              follow_up_count: 0,
              next_follow_up_at: nextFollowUpAt(sentAt, 0),
            })
            .eq("id", reminder.id);
        }
      } catch (err) {
        console.error(`[reminder-poll] dispatch failed for ${reminder.id}`, err);
        await supabase.from("reminders").update({ status: "pending" }).eq("id", reminder.id);
      }
    }

    // --- Follow-up pass: unconfirmed one-offs whose next nudge has come due.
    // Nulling next_follow_up_at IS the claim — a concurrent tick can't match a
    // null against <= now. On failure it's recomputed from (sent_at, count),
    // which is why the curve is stored as offsets from sent_at rather than as a
    // running delta: that lets the claim throw the old value away safely.
    const { data: nudges, error: nudgeErr } = await supabase
      .from("reminders")
      .update({ next_follow_up_at: null })
      .eq("status", "sent")
      .is("recurrence", null)
      .lte("next_follow_up_at", new Date().toISOString())
      .select("*");
    if (nudgeErr) {
      console.error(`[reminder-poll] follow-up claim failed: ${nudgeErr.message}`);
      return;
    }

    for (const reminder of (nudges ?? []) as ReminderRow[]) {
      const attempt = reminder.follow_up_count + 1;
      const prompt = followUpPrompt(reminder, attempt);
      try {
        if (reminder.channel === "slack" && reminder.slack_target?.channelId) {
          await receive(slack, {
            message: prompt,
            target: { channelId: reminder.slack_target.channelId },
            auth: appAuth,
          });
        } else if (reminder.phone) {
          await receive(sendblue, {
            message: prompt,
            target: { phone: reminder.phone },
            auth: appAuth,
          });
        }
        // Advance along the curve, or lapse: out of nudges, but the reminder
        // stays on the books — 'lapsed' means stop asking, not stop tracking.
        const next = reminder.sent_at ? nextFollowUpAt(reminder.sent_at, attempt) : null;
        await supabase
          .from("reminders")
          .update({
            follow_up_count: attempt,
            next_follow_up_at: next,
            ...(next ? {} : { status: "lapsed" }),
          })
          .eq("id", reminder.id);
        console.log(
          `[reminder-poll] follow-up ${attempt}/${MAX_FOLLOW_UPS} sent for ${reminder.id}` +
            (next ? "" : " (lapsed — no further outreach)"),
        );
      } catch (err) {
        console.error(`[reminder-poll] follow-up dispatch failed for ${reminder.id}`, err);
        await supabase
          .from("reminders")
          .update({
            next_follow_up_at: reminder.sent_at
              ? nextFollowUpAt(reminder.sent_at, reminder.follow_up_count)
              : null,
          })
          .eq("id", reminder.id);
      }
    }
  },
});
