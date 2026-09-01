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
  authorizedPartySizes,
  book,
  depositWithinBounds,
  describeSlot,
  findReservationFor,
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
import { formatLocal, primeOwnerTimezone } from "#lib/reminders.js";
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
/** How long one invocation watches before releasing its lease to the next tick. */
const WATCH_PASS_MS = 50_000;
/** Detection granularity in watch mode. Fast enough to matter, slow enough to be polite. */
const WATCH_POLL_INTERVAL_MS = 3_000;
/** A watch lease older than this was orphaned; let another worker take the row. */
const LEASE_STALE_MS = 90_000;
/** Re-attempts of the SAME slot after a request that never arrived. Bounded, but not zero. */
const MAX_TRANSPORT_RETRIES = 2;
/**
 * How long a fallback table is HELD before it's taken, in find-polls (~1s).
 *
 * A drop is normally one inventory flip, but "normally" is doing real work in
 * that sentence. If the two-tops land a few hundred milliseconds before the
 * four-tops, booking the first thing we see takes the table he settled for
 * while the one he actually asked for was about to publish — and he'd never
 * know, because a fallback win looks exactly like a fallback that was needed.
 * So the primary keeps being asked for another second before the smaller table
 * is accepted. Costs ~1s, and only on the fallback path.
 */
const FALLBACK_GRACE_POLLS = 4;
/**
 * A watch longer than this isn't waiting for a drop — it's waiting for a
 * CANCELLATION, and the right cadence is completely different.
 *
 * A drop is a known ~90-minute window where inventory appears at one instant, so
 * polling every 3s is proportionate: ~1,800 requests, once. A cancellation watch
 * runs for days or weeks with no expected moment, and that same cadence would be
 * ~29,000 requests a day against a WAF, indefinitely — which is both rude and a
 * good way to get an account flagged.
 *
 * So the window length itself selects the cadence: short window → tight poll,
 * long window → one poll per cron tick (~1/min), which needs no extra machinery
 * because the cron already ticks every minute.
 */
const DROP_WINDOW_MAX_MS = 6 * 3600_000;

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
  | {
      kind: "booked";
      slot: ResySlot;
      /** The size this table was booked for — the fallback when the primary had nothing. */
      partySize: number;
      resyToken: string;
      reservationId: string | null;
      depositCents: number;
      /** Won, but only discovered by verifying after a timed-out write. */
      recovered?: boolean;
    }
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

  // The party sizes he authorized, in the order he wants them. Both are asked
  // inside the SAME poll rather than one after the other, because a drop that
  // publishes no table for the larger party publishes the smaller ones at that
  // same instant — giving up on the primary first would spend the race.
  const sizes = authorizedPartySizes(snipe);
  const primarySize = sizes[0];
  const sizeLabel = sizes.length > 1 ? `${sizes[0]} or ${sizes[1]}` : `${sizes[0]}`;

  let ranked: ResySlot[] = [];
  let partySize = snipe.party_size;
  let polls = 0;
  let sawSlotsOutsideWindow = false;
  // A fallback table found while the primary is still empty is held, not taken.
  // Refreshed every poll so it can't go stale, and released after the grace.
  let held: ResySlot[] = [];
  let heldSize = 0;
  let graceLeft = FALLBACK_GRACE_POLLS;

  poll: for (; polls < MAX_FIND_POLLS; polls++) {
    let sawInventory = false;
    let fallbackRanked: ResySlot[] | null = null; // null = no answer for it this poll

    for (const size of sizes) {
      let slots: ResySlot[];
      try {
        slots = await findSlots({
          venueId: snipe.venue_id,
          day: snipe.reservation_date,
          partySize: size,
          fast: true,
        });
      } catch (err) {
        // Transport hiccups are expected under load — keep polling. An auth
        // failure is not survivable, though, and burning 40 attempts on it just
        // delays telling the owner the truth.
        if (err instanceof ResyError && (err.kind === "auth" || err.kind === "not_configured")) {
          return { kind: "failed", reason: err.message, attempts: polls };
        }
        continue; // this size hiccuped; the other one may still answer
      }

      if (slots.length > 0) sawInventory = true;
      const candidates = rankSlots(slots, prefs);

      if (size === primarySize) {
        // The size he actually asked for. Nothing to weigh — take it.
        if (candidates.length > 0) {
          ranked = candidates;
          partySize = size;
          break poll;
        }
      } else {
        fallbackRanked = candidates; // an answer, even when it's empty
      }
    }

    if (fallbackRanked !== null) {
      held = fallbackRanked;
      heldSize = sizes[1];
    }
    if (held.length > 0 && graceLeft-- <= 0) {
      ranked = held;
      partySize = heldSize;
      break;
    }

    if (sawInventory && held.length === 0) {
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
        ? `tables opened, but nothing for ${sizeLabel} between ` +
          `${formatTime(prefs.earliestTime)} and ${formatTime(prefs.latestTime)}`
        : `nothing ever opened up for ${sizeLabel}`,
      attempts: polls,
    };
  }

  let lastReason = "every table we tried was taken first";
  let retriedTransport = 0;
  const candidates = ranked.slice(0, MAX_BOOK_ATTEMPTS);

  for (let i = 0; i < candidates.length; i++) {
    const slot = candidates[i];
    try {
      const details = await slotDetails({
        configToken: slot.configToken,
        day: snipe.reservation_date,
        partySize,
        fast: true,
      });

      // The deposit cap is a hard bound from the approval card. Over it, this
      // slot is simply not authorized — skip to the next rather than abandoning
      // the snipe, since a cheaper table may sit one rank down.
      if (!depositWithinBounds(details.chargeCents, snipe.max_deposit_cents)) {
        lastReason =
          `the tables that opened cost ${details.chargeLabel ?? formatUsd(details.chargeCents)} ` +
          `(${details.chargeType}), over the ${formatUsd(snipe.max_deposit_cents)} limit you set`;
        continue;
      }

      const result = await book({
        bookToken: details.bookToken,
        // Always — a free table can still require a card on file, and a 402 at
        // T-0 loses the reservation outright.
        paymentMethodId: details.paymentMethodId,
        fast: true,
      });

      return {
        kind: "booked",
        slot,
        partySize,
        resyToken: result.resyToken,
        reservationId: result.reservationId,
        depositCents: details.chargeCents,
      };
    } catch (err) {
      if (err instanceof ResyError) {
        // ⚠️ A TIMEOUT IS NOT A FAILURE — it is an unknown. The request may have
        // reached Resy and committed before we stopped waiting. On 2026-08-05
        // exactly that happened: /3/book aborted client-side at 3s, Resy booked
        // the table anyway, the owner was charged $54.44, and the snipe told him
        // it had lost. Never announce a loss on a timed-out write without
        // asking the account what actually happened.
        if (err.kind === "transport") {
          const existing = await findReservationFor(snipe.venue_id, snipe.reservation_date).catch(
            () => null,
          );
          if (existing) {
            return {
              kind: "booked",
              slot: { ...slot, time: existing.time ?? slot.time, type: existing.slotType ?? slot.type },
              partySize,
              resyToken: existing.resyToken,
              reservationId: existing.reservationId,
              depositCents: 0, // unknown from this path; the confirmation carries the real figure
              recovered: true,
            };
          }
          // Genuinely didn't land. The slot may well still be there, so retry
          // THIS one rather than skipping to the next — moving on is right for a
          // slot someone else took, not for a request that never arrived.
          lastReason = "Resy stopped responding while we were booking";
          if (retriedTransport < MAX_TRANSPORT_RETRIES) {
            retriedTransport++;
            i--;
          }
          continue;
        }
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
  const dropAt = Date.parse(snipe.drop_at!);

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
 * Watch mode: no known drop second, so poll until inventory shows up.
 *
 * Used when a venue's release time is unknown — which is the normal case, since
 * Resy publishes no booking-window metadata and every figure online is hearsay.
 * A guessed drop_at that is an hour wrong loses silently; this cannot be wrong
 * about the time, only a few seconds late, and a few seconds is a rounding error
 * against an hour.
 *
 * Runs for most of one cron minute, then RELEASES the lease so the next tick
 * picks the row up again. The row is never consumed by an empty poll — only a
 * booking, or the window ending, finishes it.
 */
async function runWatch(
  snipe: ResySnipeRow,
  receive: Receive,
  appAuth: ScheduleHandlerArgs["appAuth"],
): Promise<void> {
  try {
    await Promise.all([resyApiKey(), getAuthToken(true)]);
  } catch (err) {
    const reason = err instanceof ResyError ? err.message : redact(String(err));
    await finish(snipe, { kind: "failed", reason, attempts: 0 }, receive, appAuth);
    return;
  }

  // Cancellation watches take a single look per tick; drop watches hold the
  // invocation and poll hard. See DROP_WINDOW_MAX_MS.
  const windowMs = Date.parse(snipe.watch_until!) - Date.parse(snipe.watch_from!);
  const isCancellationWatch = windowMs > DROP_WINDOW_MAX_MS;

  const until = isCancellationWatch
    ? Date.now() // one pass, then release
    : Math.min(
        Date.now() + WATCH_PASS_MS,
        Date.parse(snipe.watch_until!), // never poll past the owner's window
      );

  // Both authorized sizes are watched, not just the primary. A drop that never
  // publishes a table for the larger party is exactly the case a fallback exists
  // for, and watching only the primary would sit through it seeing nothing.
  const sizes = authorizedPartySizes(snipe);

  do {
    let slots: ResySlot[] = [];
    for (const size of sizes) {
      try {
        slots = await findSlots({
          venueId: snipe.venue_id,
          day: snipe.reservation_date,
          partySize: size,
          fast: true,
        });
      } catch (err) {
        if (err instanceof ResyError && (err.kind === "auth" || err.kind === "not_configured")) {
          await finish(snipe, { kind: "failed", reason: err.message, attempts: 0 }, receive, appAuth);
          return;
        }
        // Transport noise mid-drop is expected; keep watching.
        slots = [];
      }
      if (slots.length > 0) break; // something published — hand it to the race
    }

    if (slots.length > 0) {
      // Inventory exists. Stamp the moment BEFORE racing: this is the
      // measurement that lets every future snipe at this venue use a precise
      // drop_at instead of a wide window, and it must survive the race failing.
      const detectedAt = new Date().toISOString();
      await supabase.from("resy_snipes").update({ detected_at: detectedAt }).eq("id", snipe.id);

      // Hand to the same race the precise path uses — it re-fetches, ranks, and
      // walks candidates identically.
      const outcome = await race(snipe);
      await finish({ ...snipe, detected_at: detectedAt }, outcome, receive, appAuth);
      return;
    }
    if (isCancellationWatch) break;
    await sleep(WATCH_POLL_INTERVAL_MS);
  } while (Date.now() < until);

  // Window still open, nothing yet: release the lease for the next tick. This is
  // the whole reason watch rows keep status 'armed' — a status flip here would
  // consume the snipe on its first empty minute.
  await supabase
    .from("resy_snipes")
    .update({ fired_at: null })
    .eq("id", snipe.id)
    .eq("status", "armed");
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
        booked_party_size: outcome.partySize,
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
  // A watch that saw inventory learned the venue's release time. Say it out
  // loud either way: it is the thing that makes the next attempt precise, and a
  // lost race that measured the drop is not a wasted morning.
  const measured = snipe.detected_at
    ? ` You were watching a window rather than a known drop time, and inventory ` +
      `actually appeared at ${formatLocal(snipe.detected_at)} — tell him that, ` +
      `briefly, as something useful you now know about this restaurant.`
    : "";

  // A fallback win is NOT the table he asked for, and a text that reads like one
  // has him arriving with four people to a two-top. Say the number that was
  // actually booked, and say it fell back, in the same breath.
  const fellBack =
    outcome.kind === "booked" && outcome.partySize !== snipe.party_size
      ? ` IMPORTANT: no table for ${snipe.party_size} was released, so this is the smaller ` +
        `party of ${outcome.partySize} he authorised as a fallback. Say that plainly — he needs ` +
        `to know the table seats ${outcome.partySize}, not ${snipe.party_size} — and don't ` +
        `present it as the table he originally wanted.`
      : "";

  const sizeWanted = snipe.fallback_party_size
    ? `${snipe.party_size} (or ${snipe.fallback_party_size})`
    : `${snipe.party_size}`;

  const prompt =
    outcome.kind === "booked"
      ? `A reservation you were sniping for the owner just came through: ` +
        `${describeSlot(snipe.venue_name, snipe.reservation_date, outcome.slot)}, party of ` +
        `${outcome.partySize}` +
        (outcome.reservationId ? `, confirmation ${outcome.reservationId}` : "") +
        (outcome.depositCents > 0 ? `, ${formatUsd(outcome.depositCents)} deposit taken` : "") +
        `. Text him the good news in one or two short lines — the restaurant, the day, the time, ` +
        `the party size. Use ONLY these details and don't invent an address or a dress code.` +
        (outcome.recovered
          ? ` NOTE: Resy stopped responding mid-booking and we only confirmed this by checking ` +
            `his account afterwards, so the reservation is real but the charge amount isn't ` +
            `known from here. Mention that a card may have been charged and he can see the ` +
            `exact figure in the Resy app — do NOT quote a number.`
          : "") +
        fellBack +
        measured
      : `A reservation snipe just LOST: ${snipe.venue_name} on ${snipe.reservation_date} for ` +
        `${sizeWanted}, wanted between ${formatTime(hhmm(snipe.earliest_time))} and ` +
        `${formatTime(hhmm(snipe.latest_time))}. What happened: ${outcome.reason}. Tell him ` +
        `straight away, in one or two lines, without drama and without apologising twice. ` +
        `Offer to try again at the next drop or to look at nearby nights. Do NOT claim anything ` +
        `was booked.` + measured;

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
    // Load any travel override before any clock is read; see primeOwnerTimezone.
    await primeOwnerTimezone();
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

    // --- 1. Expire watch windows that closed without ever seeing inventory.
    const { data: lapsed } = await supabase
      .from("resy_snipes")
      .update({ status: "missed", last_error: "watch window closed with nothing released" })
      .eq("status", "armed")
      .not("watch_until", "is", null)
      .lt("watch_until", new Date(now).toISOString())
      .select("*")
      .returns<ResySnipeRow[]>();

    for (const s of lapsed ?? []) {
      try {
        await dispatch(
          receive,
          appAuth,
          s,
          `A reservation watch just ended without anything opening: ${s.venue_name} on ` +
            `${s.reservation_date} for ${s.party_size}` +
            (s.fallback_party_size ? ` (or ${s.fallback_party_size})` : "") +
            `. Nothing was booked and nothing is ` +
            `still watching. Tell him in one short line and offer to try the next release.`,
        );
      } catch (err) {
        console.error("[resy-snipe] lapse notice failed", err);
      }
    }

    // --- 2. Claim PRECISE snipes: one shot, status flips so a duplicate cron
    // delivery gets zero rows and cannot double-book.
    const { data: claimed, error } = await supabase
      .from("resy_snipes")
      .update({ status: "firing", fired_at: new Date().toISOString() })
      .eq("status", "armed")
      .not("drop_at", "is", null)
      .gte("drop_at", new Date(now - GRACE_MS).toISOString())
      .lte("drop_at", new Date(now + LOOKAHEAD_MS).toISOString())
      .select("*")
      .returns<ResySnipeRow[]>();
    if (error) throw new Error(`[resy-snipe] claim failed: ${error.message}`);

    // --- 3. LEASE watch-mode snipes whose window is open. status stays 'armed'
    // (an empty minute must not consume the row); fired_at is the lease, and a
    // stale one is reclaimable so a crashed worker doesn't park the snipe.
    const { data: leased, error: leaseErr } = await supabase
      .from("resy_snipes")
      .update({ fired_at: new Date().toISOString() })
      .eq("status", "armed")
      .not("watch_from", "is", null)
      .lte("watch_from", new Date(now).toISOString())
      .gte("watch_until", new Date(now).toISOString())
      .or(`fired_at.is.null,fired_at.lt.${new Date(now - LEASE_STALE_MS).toISOString()}`)
      .select("*")
      .returns<ResySnipeRow[]>();
    if (leaseErr) console.error(`[resy-snipe] lease failed: ${leaseErr.message}`);

    const due = claimed ?? [];
    const watching = leased ?? [];
    if (due.length === 0 && watching.length === 0) return;

    console.log(`[resy-snipe] ${due.length} firing, ${watching.length} watching`);

    // Concurrent, not sequential: two venues dropping in the same minute are
    // independent races, and making one wait for the other loses the second.
    // Each settles on its own — one failure must not strand another's booking.
    const work = Promise.allSettled([
      ...due.map((s) => runSnipe(s, receive, appAuth)),
      ...watching.map((s) => runWatch(s, receive, appAuth)),
    ]);
    waitUntil(work);
    await work;
  },
});
