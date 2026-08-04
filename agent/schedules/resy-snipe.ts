import { defineSchedule } from "eve/schedules";
import type { ScheduleHandlerArgs } from "eve/schedules";
import sendblue from "#channels/sendblue.js";
import slack from "#channels/slack.js";
import {
  FIND_POLL_INTERVAL_MS,
  MAX_BOOK_ATTEMPTS,
  MAX_FIND_POLLS,
  PREWARM_LEAD_MS,
  RACE_LEAD_MS,
  ResyError,
  book,
  depositWithinBounds,
  describeSlot,
  findSlots,
  formatTime,
  formatUsd,
  getAuthToken,
  hhmm,
  rankSlots,
  redact,
  resyApiKey,
  slotDetails,
  type ResySlot,
  type ResySnipeRow,
} from "#lib/resy.js";
import { ensureResyStore } from "#lib/resy-store.js";
import { supabase } from "#lib/supabase.js";

/**
 * The drop race: books a pre-authorized table the instant Resy publishes it.
 *
 * WHY A MINUTE CRON CAN HIT A ONE-SECOND WINDOW. Vercel cron fires at most once
 * a minute, which is nowhere near precise enough on its own. So this ticks every
 * minute, looks ~90s ahead, CLAIMS anything about to drop, and then holds the
 * invocation open — sleeping to the exact millisecond before it starts asking.
 * agent/schedules/sendblue-poll.ts already proves a ~50s in-invocation hold
 * works on this deployment; this is the same trick pointed at a deadline
 * instead of a poll interval.
 *
 * WHY THE PRE-WARM MATTERS MORE THAN THE LOOP. Scraping the API key is two HTTP
 * round trips and refreshing the auth token is a third. Paying for those at T-0
 * is the difference between a table and a miss, so they happen ~10s early, off
 * the clock. Everything inside the race is already warm.
 *
 * WHY THE CLAIM IS NOT OPTIONAL. Vercel can deliver a cron twice and eve re-runs
 * interrupted steps. Here a re-run books the same table twice, on an account
 * that gets suspended for exactly that, with two cancellation fees. The claim is
 * an UPDATE ... RETURNING gated on `status = 'armed'`: the second worker gets
 * zero rows and goes home. Reading the row and then writing it is NOT a claim.
 *
 * `eve dev` never fires crons — trigger locally with
 * `curl -X POST http://localhost:3000/eve/v1/dev/schedules/resy-snipe`.
 */

type Receive = ScheduleHandlerArgs["receive"];

/** How far ahead to claim. Must exceed the 60s cron granularity or drops slip through. */
const LOOKAHEAD_MS = 90_000;
/** A drop we arrived late for is still worth trying — tables linger for a moment. */
const GRACE_MS = 120_000;
/** A 'firing' row older than this was orphaned by a crash mid-race. */
const STUCK_MS = 10 * 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

async function dispatch(
  receive: Receive,
  appAuth: ScheduleHandlerArgs["appAuth"],
  snipe: Pick<ResySnipeRow, "channel" | "phone" | "slack_target">,
  message: string,
): Promise<void> {
  if (snipe.channel === "slack" && snipe.slack_target?.channelId) {
    await receive(slack, {
      message,
      target: { channelId: snipe.slack_target.channelId },
      auth: appAuth,
    });
    return;
  }
  const phone = snipe.phone ?? process.env.OWNER_PHONE;
  if (!phone) throw new Error("no delivery target (OWNER_PHONE missing)");
  await receive(sendblue, { message, target: { phone }, auth: appAuth });
}

type RaceOutcome =
  | { kind: "booked"; slot: ResySlot; resyToken: string; reservationId: string | null; depositCents: number }
  | { kind: "missed"; reason: string; attempts: number }
  | { kind: "failed"; reason: string; attempts: number };

/**
 * Everything that happens between T-0 and a confirmed table.
 *
 * Two nested loops, doing different jobs:
 *  - the FIND loop waits for inventory to exist. Resy routinely publishes a few
 *    hundred ms after the advertised second, so asking once at T-0 and giving up
 *    is a common way to lose a table that was there all along.
 *  - the BOOK loop walks the ranked slots. Losing the top slot to someone faster
 *    is the normal case, not an error — 404/412 means "gone", so take the next
 *    one rather than aborting the whole snipe.
 */
async function race(snipe: ResySnipeRow): Promise<RaceOutcome> {
  const prefs = {
    earliestTime: hhmm(snipe.earliest_time),
    latestTime: hhmm(snipe.latest_time),
    preferredTime: snipe.preferred_time ? hhmm(snipe.preferred_time) : null,
    slotTypes: snipe.slot_types,
  };

  let ranked: ResySlot[] = [];
  let polls = 0;
  let sawSlotsOutsideWindow = false;

  for (; polls < MAX_FIND_POLLS; polls++) {
    let slots: ResySlot[];
    try {
      slots = await findSlots({
        venueId: snipe.venue_id,
        day: snipe.reservation_date,
        partySize: snipe.party_size,
        fast: true,
      });
    } catch (err) {
      // Transport hiccups are expected under load — keep polling. An auth
      // failure is not survivable, though, and burning 40 attempts on it just
      // delays telling the owner the truth.
      if (err instanceof ResyError && (err.kind === "auth" || err.kind === "not_configured")) {
        return { kind: "failed", reason: err.message, attempts: polls };
      }
      await sleep(FIND_POLL_INTERVAL_MS);
      continue;
    }

    if (slots.length > 0) {
      ranked = rankSlots(slots, prefs);
      if (ranked.length > 0) break;
      // Inventory exists but none of it is inside the window he authorized.
      // That's a real answer, not a reason to keep hammering: the window is the
      // authorization, and booking outside it is not ours to do.
      sawSlotsOutsideWindow = true;
      break;
    }
    await sleep(FIND_POLL_INTERVAL_MS);
  }

  if (ranked.length === 0) {
    return {
      kind: "missed",
      reason: sawSlotsOutsideWindow
        ? `tables opened but none between ${formatTime(prefs.earliestTime)} and ${formatTime(prefs.latestTime)}`
        : "nothing ever opened up",
      attempts: polls,
    };
  }

  let lastReason = "every table we tried was taken first";
  const candidates = ranked.slice(0, MAX_BOOK_ATTEMPTS);

  for (let i = 0; i < candidates.length; i++) {
    const slot = candidates[i];
    try {
      const details = await slotDetails({
        configToken: slot.configToken,
        day: snipe.reservation_date,
        partySize: snipe.party_size,
        fast: true,
      });

      // The deposit cap is a hard bound from the approval card. Over it, this
      // slot is simply not authorized — skip to the next rather than abandoning
      // the snipe, since a cheaper table may sit one rank down.
      if (!depositWithinBounds(details.depositCents, snipe.max_deposit_cents)) {
        lastReason =
          `the tables that opened wanted a ${formatUsd(details.depositCents)} deposit, over the ` +
          `${formatUsd(snipe.max_deposit_cents)} limit you set`;
        continue;
      }

      const result = await book({
        bookToken: details.bookToken,
        paymentMethodId: details.depositCents > 0 ? details.paymentMethodId : null,
        fast: true,
      });

      return {
        kind: "booked",
        slot,
        resyToken: result.resyToken,
        reservationId: result.reservationId,
        depositCents: details.depositCents,
      };
    } catch (err) {
      if (err instanceof ResyError) {
        if (err.kind === "gone") {
          lastReason = "every table we tried was taken first";
          continue; // the normal way a race is lost
        }
        if (err.kind === "payment_required") {
          lastReason = "Resy wanted a deposit and there's no usable card on the account";
          continue;
        }
        if (err.kind === "recaptcha") {
          return { kind: "failed", reason: "the venue demanded a reCAPTCHA at booking", attempts: i + 1 };
        }
        if (err.kind === "auth") {
          return { kind: "failed", reason: err.message, attempts: i + 1 };
        }
        lastReason = err.message;
        continue;
      }
      lastReason = redact(String(err));
    }
  }

  return { kind: "missed", reason: lastReason, attempts: candidates.length };
}

/** Pre-warm, hold to the deadline, race, then write the outcome. */
async function runSnipe(
  snipe: ResySnipeRow,
  receive: Receive,
  appAuth: ScheduleHandlerArgs["appAuth"],
): Promise<void> {
  const dropAt = Date.parse(snipe.drop_at);

  // --- Pre-warm, deliberately BEFORE the wait so the cost lands off the clock.
  try {
    await Promise.all([resyApiKey(), getAuthToken(true)]);
  } catch (err) {
    const reason = err instanceof ResyError ? err.message : redact(String(err));
    await finish(snipe, { kind: "failed", reason, attempts: 0 }, receive, appAuth);
    return;
  }

  // --- Hold to the deadline, minus a small lead: our clock and Resy's disagree,
  // and being 400ms early costs one wasted poll while being late costs the table.
  await sleep(dropAt - RACE_LEAD_MS - Date.now());

  const outcome = await race(snipe);
  await finish(snipe, outcome, receive, appAuth);
}

/**
 * Persist the outcome, THEN tell the owner.
 *
 * Order matters: if the text fails we still have a record of a real booking. The
 * reverse order can leave a table reserved that nothing in the database knows
 * about, which is how a person ends up not showing up to a reservation they're
 * being charged for.
 */
async function finish(
  snipe: ResySnipeRow,
  outcome: RaceOutcome,
  receive: Receive,
  appAuth: ScheduleHandlerArgs["appAuth"],
): Promise<void> {
  const now = new Date().toISOString();

  if (outcome.kind === "booked") {
    const { error } = await supabase
      .from("resy_snipes")
      .update({
        status: "booked",
        resy_token: outcome.resyToken,
        reservation_id: outcome.reservationId,
        booked_time: outcome.slot.time,
        booked_slot_type: outcome.slot.type,
        deposit_paid_cents: outcome.depositCents,
        attempts: 1,
        updated_at: now,
      })
      .eq("id", snipe.id);
    if (error) console.error(`[resy-snipe] booked but couldn't record it: ${error.message}`);
  } else {
    const { error } = await supabase
      .from("resy_snipes")
      .update({
        status: outcome.kind,
        attempts: outcome.attempts,
        last_error: outcome.reason.slice(0, 500),
        updated_at: now,
      })
      .eq("id", snipe.id);
    if (error) console.error(`[resy-snipe] couldn't record outcome: ${error.message}`);
  }

  // A silent miss is the worst outcome in the whole feature: he planned an
  // evening around a table he thinks is handled. Losing is fine; not being told
  // is not. So every branch here speaks, win or lose.
  const prompt =
    outcome.kind === "booked"
      ? `A reservation you were sniping for the owner just came through: ` +
        `${describeSlot(snipe.venue_name, snipe.reservation_date, outcome.slot)}, party of ` +
        `${snipe.party_size}` +
        (outcome.reservationId ? `, confirmation ${outcome.reservationId}` : "") +
        (outcome.depositCents > 0 ? `, ${formatUsd(outcome.depositCents)} deposit taken` : "") +
        `. Text him the good news in one or two short lines — the restaurant, the day, the time, ` +
        `the party size. Use ONLY these details and don't invent an address or a dress code.`
      : `A reservation snipe just LOST: ${snipe.venue_name} on ${snipe.reservation_date} for ` +
        `${snipe.party_size}, wanted between ${formatTime(hhmm(snipe.earliest_time))} and ` +
        `${formatTime(hhmm(snipe.latest_time))}. What happened: ${outcome.reason}. Tell him ` +
        `straight away, in one or two lines, without drama and without apologising twice. ` +
        `Offer to try again at the next drop or to look at nearby nights. Do NOT claim anything ` +
        `was booked.`;

  try {
    await dispatch(receive, appAuth, snipe, prompt);
  } catch (err) {
    console.error("[resy-snipe] outcome dispatch failed", err);
  }
}

export default defineSchedule({
  cron: "* * * * *",
  async run({ receive, appAuth, waitUntil }) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) return;
    // NOT gated on RESY_EMAIL/RESY_PASSWORD: most Resy accounts are OTP-only and
    // never have a password, so an env check here would silently disable every
    // snipe on exactly the accounts this feature is built for. Whether Resy is
    // connected lives in the database, and the claim below returns zero rows
    // when nothing is armed anyway.
    ensureResyStore();

    const now = Date.now();

    // --- 0. Recover rows orphaned by a crash between the claim and the race.
    // Without this they sit 'firing' forever, silently blocking a re-arm through
    // the partial unique index.
    const { data: stuck } = await supabase
      .from("resy_snipes")
      .update({ status: "failed", last_error: "interrupted mid-race", updated_at: new Date().toISOString() })
      .eq("status", "firing")
      .lt("fired_at", new Date(now - STUCK_MS).toISOString())
      .select("id");
    if (stuck?.length) console.warn(`[resy-snipe] recovered ${stuck.length} orphaned row(s)`);

    // --- 1. Claim. status is in both the SET and the WHERE, so a duplicate
    // cron delivery gets zero rows and cannot double-book.
    const { data: claimed, error } = await supabase
      .from("resy_snipes")
      .update({ status: "firing", fired_at: new Date().toISOString() })
      .eq("status", "armed")
      .gte("drop_at", new Date(now - GRACE_MS).toISOString())
      .lte("drop_at", new Date(now + LOOKAHEAD_MS).toISOString())
      .select("*")
      .returns<ResySnipeRow[]>();

    if (error) throw new Error(`[resy-snipe] claim failed: ${error.message}`);
    const due = claimed ?? [];
    if (due.length === 0) return;

    console.log(`[resy-snipe] claimed ${due.length} snipe(s)`);

    // Concurrent, not sequential: two venues dropping in the same minute are
    // independent races, and making one wait for the other loses the second.
    // Each settles on its own — one failure must not strand another's booking.
    const work = Promise.allSettled(due.map((s) => runSnipe(s, receive, appAuth)));
    waitUntil(work);
    await work;
  },
});
