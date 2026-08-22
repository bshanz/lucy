import { defineSchedule } from "eve/schedules";
import sendblue from "#channels/sendblue.js";
import slack from "#channels/slack.js";
import { fetchRecentOutbound, type SendblueMessage } from "#lib/sendblue.js";
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

/**
 * How long a healthy reminder turn may take to put a text on the wire before
 * the dispatch is called lost. The repaired session managed it in 7 seconds;
 * two minutes leaves room for a cold start plus a tool call, and is short
 * enough that a wedged session is caught within a couple of ticks.
 */
const DELIVERY_GRACE_MS = 120_000;

/**
 * Minutes to wait before re-dispatching a one-off whose last attempt was never
 * seen to land, indexed by attempts already made.
 *
 * Retry is unbounded, with the INTERVAL capped rather than the count. The
 * failure this defends against — a session parked on a prompt nobody was shown
 * — is repaired out of band, and a reminder that had quietly given up before
 * then would reproduce the exact disappearance this mechanism exists to
 * prevent. So it keeps trying, slowly, and complains every time; the backoff is
 * only there to stop a dead session being hammered once a minute.
 */
const RETRY_BACKOFF_MIN = [1, 5, 15, 60];
const backoffMinutes = (attempts: number): number =>
  RETRY_BACKOFF_MIN[Math.min(attempts, RETRY_BACKOFF_MIN.length - 1)];

/**
 * A recurring reminder gets one cheap retry and then rolls forward.
 *
 * It cannot use the backoff above: that works by pushing fire_at, and fire_at
 * is a recurring reminder's ANCHOR — nextOccurrence steps the wall clock from
 * it, so shifting it by 15 minutes moves the 6:45am reminder to 7:00am for
 * good. One retry costs nothing (the row is already due, so the next tick picks
 * it up with fire_at untouched) and covers a transient stall; past that,
 * skipping today's instance is strictly better than permanently corrupting the
 * series, and a daily reminder comes back around tomorrow anyway.
 */
const MAX_RECURRING_ATTEMPTS = 2;

/**
 * Promote dispatches that were seen to land; re-queue the ones that were not.
 *
 * The check is deliberately COARSE: it asks whether any message left for this
 * target after the dispatch, not whether this particular reminder's words did.
 * Per-reminder correlation isn't available — the model composes the text freely,
 * so there is no id to match on — and buying it would mean sending reminders
 * around the model rather than through it, which is the whole reason they read
 * like a person wrote them.
 *
 * Coarse is still right, because it is aimed precisely at the failure that
 * actually occurs: a session that has stopped speaking delivers NOTHING, so
 * "nothing left the building" is exactly the signal. What it cannot catch is a
 * live session that answered some other message in the window while silently
 * dropping this reminder. That is far narrower and far rarer than the failure
 * it replaces, and — unlike that one — it cannot be silent: the reminder still
 * lands on the follow-up curve, so the owner is asked about it within the day.
 */
async function confirmDeliveries(): Promise<void> {
  // dispatched_at is non-null for exactly as long as something is awaiting
  // confirmation, and both settle paths null it — so it is the whole predicate.
  // It covers two shapes at once: a first delivery (status 'awaiting_delivery')
  // and a follow-up nudge on an already-delivered reminder, which keeps status
  // 'sent' so it goes on listing as awaiting confirmation while it waits.
  const { data, error } = await supabase
    .from("reminders")
    .select("*")
    .not("dispatched_at", "is", null);
  if (error) {
    console.error(`[reminder-poll] delivery lookup failed: ${error.message}`);
    return;
  }
  const waiting = (data ?? []) as ReminderRow[];
  if (waiting.length === 0) return;

  let outbound: SendblueMessage[];
  try {
    // One fetch answers every waiting reminder.
    outbound = await fetchRecentOutbound(100);
  } catch (err) {
    // Can't tell delivered from lost. Leave every row exactly as it is and
    // re-check next tick — guessing in either direction writes a lie into the
    // reminder's history, which is the failure mode being fixed.
    console.error("[reminder-poll] outbound fetch failed; deferring confirmation", err);
    return;
  }

  for (const reminder of waiting) {
    const dispatchedAt = reminder.dispatched_at ? Date.parse(reminder.dispatched_at) : 0;
    // 'sent' + a pending dispatch means the reminder itself already landed and
    // what's in flight is a nudge about it.
    const isNudge = reminder.status === "sent";

    // Slack has no outbound lookup wired here, so Slack reminders keep the old
    // optimistic contract: dispatched counts as delivered. Stated out loud
    // rather than silently assumed — this is the seam to close if Slack ever
    // becomes a primary surface.
    if (reminder.channel !== "imessage" || !reminder.phone) {
      const at = reminder.dispatched_at ?? new Date().toISOString();
      await (isNudge ? advanceFollowUp(reminder) : markDelivered(reminder, at));
      continue;
    }

    // EARLIEST match, not the first one found. fetchRecentOutbound returns
    // newest-first, so a plain .find() picks the most recent message since the
    // dispatch — which is some later, unrelated reply whenever the conversation
    // has moved on before this tick ran. Caught by a smoke test that stamped a
    // reminder dispatched at 13:22:40 with a 13:41:26 delivery, 19 minutes off.
    // The first thing to leave after a dispatch is the one that dispatch
    // produced, and sent_at has to be that instant: the follow-up curve hangs
    // off it, so a late stamp quietly delays every nudge that follows.
    const landed = outbound
      .filter(
        (m) =>
          m.to_number === reminder.phone &&
          m.status !== "ERROR" &&
          Date.parse(m.date_sent) > dispatchedAt,
      )
      .sort((a, b) => Date.parse(a.date_sent) - Date.parse(b.date_sent))[0];
    if (landed) {
      await (isNudge ? advanceFollowUp(reminder) : markDelivered(reminder, landed.date_sent));
      continue;
    }
    // Still inside the grace window: the turn may simply not be finished.
    if (Date.now() - dispatchedAt < DELIVERY_GRACE_MS) continue;
    await (isNudge ? requeueNudge(reminder) : requeue(reminder));
  }
}

/**
 * A nudge was seen to land, so the curve finally moves: the count goes up and
 * the next deadline is computed, or the reminder lapses because the curve is
 * spent.
 *
 * This is the step that used to run on dispatch, and moving it here is the
 * whole point. Advancing on dispatch meant three swallowed nudges walked a
 * reminder straight to 'lapsed' — terminal, no further outreach — without the
 * owner ever being asked once. The reminder stayed on his list looking like
 * something he had ignored three times.
 *
 * Takes no delivery timestamp on purpose: the curve is offsets from sent_at,
 * the moment the REMINDER landed, not the nudge. Anchoring a nudge to itself
 * would stretch the schedule a little further every round.
 */
async function advanceFollowUp(reminder: ReminderRow): Promise<void> {
  const attempt = reminder.follow_up_count + 1;
  const next = reminder.sent_at ? nextFollowUpAt(reminder.sent_at, attempt) : null;
  await supabase
    .from("reminders")
    .update({
      follow_up_count: attempt,
      next_follow_up_at: next,
      dispatched_at: null,
      delivery_attempts: 0,
      ...(next ? {} : { status: "lapsed" }),
    })
    .eq("id", reminder.id);
  console.log(
    `[reminder-poll] follow-up ${attempt}/${MAX_FOLLOW_UPS} confirmed for ${reminder.id}` +
      (next ? "" : " (lapsed — no further outreach)"),
  );
}

/**
 * A nudge went nowhere. Put the deadline back so the SAME nudge number is tried
 * again — follow_up_count deliberately does not move, because nothing was
 * asked.
 *
 * Backoff by pushing next_follow_up_at is safe here in a way it is not for a
 * recurring reminder's fire_at: this is a derived deadline, not an anchor.
 * advanceFollowUp recomputes it from (sent_at, count) on the next confirmed
 * delivery, so a retry can shift a nudge later without bending the curve.
 */
async function requeueNudge(reminder: ReminderRow): Promise<void> {
  const wait = backoffMinutes(reminder.delivery_attempts);
  console.error(
    `[reminder-poll] follow-up ${reminder.follow_up_count + 1}/${MAX_FOLLOW_UPS} for ` +
      `${reminder.id} was dispatched but nothing reached ${reminder.phone} within ` +
      `${DELIVERY_GRACE_MS / 1000}s. The agent session is probably parked and silently ` +
      `queueing messages. Retrying the same nudge in ${wait}m.`,
  );
  await supabase
    .from("reminders")
    .update({
      next_follow_up_at: new Date(Date.now() + wait * 60_000).toISOString(),
      dispatched_at: null,
    })
    .eq("id", reminder.id);
}

/**
 * A dispatch was seen to land. A recurring reminder rolls forward to its next
 * occurrence; a one-off becomes 'sent' and picks up the follow-up curve — and
 * the curve now hangs off the OBSERVED delivery time rather than the dispatch,
 * so a nudge is always measured from the moment he could first have seen it.
 */
async function markDelivered(reminder: ReminderRow, deliveredAt: string): Promise<void> {
  const patch = reminder.recurrence
    ? {
        status: "pending",
        fire_at: nextOccurrence(reminder.fire_at, reminder.recurrence),
        sent_at: deliveredAt,
      }
    : {
        status: "sent",
        sent_at: deliveredAt,
        follow_up_count: 0,
        next_follow_up_at: nextFollowUpAt(deliveredAt, 0),
      };
  await supabase
    .from("reminders")
    .update({ ...patch, delivery_attempts: 0, dispatched_at: null })
    .eq("id", reminder.id);
}

/**
 * Nothing left for the owner inside the grace window, so the dispatch was
 * swallowed — in practice, by a session parked on an input request nobody was
 * shown. Put the reminder back in the queue and say so at error level: this is
 * the single place the whole failure becomes visible, and it is meant to be
 * noisy enough to notice.
 */
async function requeue(reminder: ReminderRow): Promise<void> {
  const attempts = reminder.delivery_attempts;
  const recurring = reminder.recurrence !== null;
  const giveUp = recurring && attempts >= MAX_RECURRING_ATTEMPTS;

  console.error(
    `[reminder-poll] reminder ${reminder.id} was dispatched but nothing reached ` +
      `${reminder.phone} within ${DELIVERY_GRACE_MS / 1000}s (attempt ${attempts}). ` +
      "The agent session is probably parked and silently queueing messages. " +
      (giveUp
        ? "Recurring — skipping this occurrence to keep the schedule anchored."
        : `Retrying in ${recurring ? 0 : backoffMinutes(attempts)}m.`),
  );

  if (giveUp) {
    await supabase
      .from("reminders")
      .update({
        status: "pending",
        fire_at: nextOccurrence(reminder.fire_at, reminder.recurrence!),
        dispatched_at: null,
        delivery_attempts: 0,
      })
      .eq("id", reminder.id);
    return;
  }

  await supabase
    .from("reminders")
    .update({
      status: "pending",
      // Recurring rows keep fire_at untouched (it is the series anchor, and the
      // row is already due, so the next tick retries immediately).
      ...(recurring
        ? {}
        : { fire_at: new Date(Date.now() + backoffMinutes(attempts) * 60_000).toISOString() }),
      dispatched_at: null,
    })
    .eq("id", reminder.id);
}

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

    // Settle last tick's dispatches first, so a reminder that landed is
    // promoted before anything else runs and a swallowed one is back in the
    // queue in time for the claim below to pick it up.
    await confirmDeliveries();

    const { data, error } = await supabase
      .from("reminders")
      .update({ status: "sending" })
      .eq("status", "pending")
      .lte("fire_at", new Date().toISOString())
      .select("*");
    if (error) throw new Error(`[reminder-poll] claim failed: ${error.message}`);

    // Deliberately NOT an early return on an empty batch: the follow-up pass
    // below is a separate query with its own schedule, and returning here would
    // gate it on a reminder happening to come due in the very same minute. An
    // empty loop is the correct no-op; only the log is worth suppressing.
    const due = (data ?? []) as ReminderRow[];
    if (due.length > 0) console.log(`[reminder-poll] delivering ${due.length} reminder(s)`);

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

        // Dispatched, NOT delivered — and the difference is the whole point.
        // receive() resolves the moment the session accepts the message; the
        // text is composed and sent seconds later, or never at all if the
        // session is parked. confirmDeliveries() decides which happened, on a
        // later tick, from Sendblue's own record of what left.
        await supabase
          .from("reminders")
          .update({
            status: "awaiting_delivery",
            dispatched_at: new Date().toISOString(),
            delivery_attempts: reminder.delivery_attempts + 1,
          })
          .eq("id", reminder.id);
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
    // dispatched_at goes on in the same claim: from here the row is a nudge
    // awaiting confirmation, and confirmDeliveries owns it until it either
    // lands (advanceFollowUp) or doesn't (requeueNudge). Status stays 'sent'
    // throughout, so the reminder keeps listing as awaiting confirmation.
    const { data: nudges, error: nudgeErr } = await supabase
      .from("reminders")
      .update({ next_follow_up_at: null, dispatched_at: new Date().toISOString() })
      .eq("status", "sent")
      .is("recurrence", null)
      .is("dispatched_at", null)
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
        // The curve does NOT move here. Handing a nudge to the session is not
        // asking him anything — confirmDeliveries advances the count only once
        // a message is seen leaving. Only the attempt counter moves, and it
        // drives the retry backoff if this one turns out to have gone nowhere.
        await supabase
          .from("reminders")
          .update({ delivery_attempts: reminder.delivery_attempts + 1 })
          .eq("id", reminder.id);
        console.log(
          `[reminder-poll] follow-up ${attempt}/${MAX_FOLLOW_UPS} dispatched for ${reminder.id}`,
        );
      } catch (err) {
        // The dispatch itself threw, so nothing is in flight: give the deadline
        // straight back rather than leaving it to the grace window.
        console.error(`[reminder-poll] follow-up dispatch failed for ${reminder.id}`, err);
        await supabase
          .from("reminders")
          .update({
            next_follow_up_at: reminder.sent_at
              ? nextFollowUpAt(reminder.sent_at, reminder.follow_up_count)
              : null,
            dispatched_at: null,
          })
          .eq("id", reminder.id);
      }
    }
  },
});
