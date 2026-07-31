import { defineSchedule } from "eve/schedules";
import sendblue from "#channels/sendblue.js";
import slack from "#channels/slack.js";
import { nextOccurrence, supabase, type ReminderRow } from "#lib/reminders.js";

/**
 * Delivers due reminders, then runs the follow-up pass: a one-off reminder
 * that fired 24h+ ago without the owner confirming it gets ONE nudge asking
 * whether he did it or wants to reschedule. Recurring reminders never get
 * nudges (they re-fire on their own).
 *
 * Claim rows atomically before dispatch; on failure roll back so the next
 * tick retries — interrupted schedule steps re-run, so the claim is what
 * prevents double sends.
 */
const FOLLOW_UP_AFTER_MS = 24 * 3600 * 1000;
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
          await supabase
            .from("reminders")
            .update({ status: "sent", sent_at: new Date().toISOString() })
            .eq("id", reminder.id);
        }
      } catch (err) {
        console.error(`[reminder-poll] dispatch failed for ${reminder.id}`, err);
        await supabase.from("reminders").update({ status: "pending" }).eq("id", reminder.id);
      }
    }

    // --- Follow-up pass: unconfirmed one-offs, 24h+ after firing, one nudge only.
    // Claim by flipping followed_up first; revert on dispatch failure.
    const { data: nudges, error: nudgeErr } = await supabase
      .from("reminders")
      .update({ followed_up: true })
      .eq("status", "sent")
      .eq("followed_up", false)
      .is("recurrence", null)
      .lte("sent_at", new Date(Date.now() - FOLLOW_UP_AFTER_MS).toISOString())
      .select("*");
    if (nudgeErr) {
      console.error(`[reminder-poll] follow-up claim failed: ${nudgeErr.message}`);
      return;
    }

    for (const reminder of (nudges ?? []) as ReminderRow[]) {
      const prompt =
        `Follow-up check: about 24 hours ago you reminded the owner to "${reminder.body}" ` +
        `(reminder id ${reminder.id}) and he hasn't confirmed doing it. Casually ask ` +
        `whether he got to it — if he did, mark it with complete_reminder; if he wants ` +
        `more time, reschedule it with reschedule_reminder; if he says drop it, cancel it.`;
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
        console.log(`[reminder-poll] follow-up sent for ${reminder.id}`);
      } catch (err) {
        console.error(`[reminder-poll] follow-up dispatch failed for ${reminder.id}`, err);
        await supabase.from("reminders").update({ followed_up: false }).eq("id", reminder.id);
      }
    }
  },
});
