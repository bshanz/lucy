import { defineSchedule } from "eve/schedules";
import type { ScheduleHandlerArgs } from "eve/schedules";
import sendblue from "#channels/sendblue.js";
import slack from "#channels/slack.js";
import {
  EXPIRE_DAYS_BEFORE,
  FlightSearchError,
  QUOTA_RESERVE,
  accountQuota,
  addDays,
  evaluateAlert,
  formatTripDates,
  formatUsd,
  ownerToday,
  routeLabel,
  searchFlights,
  summarizeItinerary,
  type FlightWatchRow,
} from "#lib/flights.js";
import { ownerLocalHour, primeOwnerTimezone } from "#lib/reminders.js";
import { supabase } from "#lib/supabase.js";

/**
 * Daily flight price check for every active watch.
 *
 * CRON: runs hourly and gates on the owner's LOCAL hour. Vercel evaluates cron
 * in UTC with no DST, so a hardcoded hour drifts an hour twice a year and is
 * simply wrong for any non-US OWNER_TIMEZONE ("0 8 * * *" is 4am in New York).
 * The 23 no-op invocations cost nothing and spend zero SerpApi credits.
 *
 * QUOTA: every search here is metered against 250/month, and a no-results
 * response is billed just like a successful one. So the order of operations is
 * deliberate — expire dead watches (free) and check remaining quota (free)
 * BEFORE spending anything.
 *
 * CLAIM: `checked_on` is stamped in the same UPDATE ... RETURNING that selects
 * the batch. Vercel can deliver a cron twice and eve re-runs interrupted steps,
 * and here a re-run would re-issue every billed search — so a duplicate
 * invocation must get zero rows back. Filtering on `status` alone is not a
 * claim. The same column self-heals a silently missed day.
 *
 * `eve dev` never fires crons — trigger locally with
 * `curl -X POST http://localhost:3000/eve/v1/dev/schedules/flight-poll`.
 */

/**
 * Owner-local hour to actually do the work. Overridable only so the schedule
 * can be exercised outside 9am — without this it is untestable for 23 hours a
 * day. Production never sets it.
 */
function pollHour(): number {
  const raw = Number(process.env.FLIGHT_POLL_HOUR);
  return Number.isInteger(raw) && raw >= 0 && raw <= 23 ? raw : 9;
}

const WATCH_COLUMNS =
  "id, channel, phone, slack_target, origin_query, destination_query, origin_id, " +
  "destination_id, outbound_date, return_date, currency, adults, travel_class, stops, " +
  "include_airlines, " +
  "target_price, baseline_price, last_price, last_price_at, alerted_price, alerted_at, " +
  "checked_on, last_checked_at, last_error, consecutive_errors, status, paused_reason, created_at";

type Receive = ScheduleHandlerArgs["receive"];

/** Deliver a prompt to whichever surface the watch was created from. */
async function dispatch(
  receive: Receive,
  appAuth: ScheduleHandlerArgs["appAuth"],
  watch: Pick<FlightWatchRow, "channel" | "phone" | "slack_target">,
  message: string,
): Promise<void> {
  if (watch.channel === "slack" && watch.slack_target?.channelId) {
    await receive(slack, {
      message,
      target: { channelId: watch.slack_target.channelId },
      auth: appAuth,
    });
    return;
  }
  // Fall back to OWNER_PHONE rather than dropping it (unlike reminder-poll):
  // a price alert is worth delivering on the wrong surface.
  const phone = watch.phone ?? process.env.OWNER_PHONE;
  if (!phone) throw new Error("no delivery target (OWNER_PHONE missing)");
  await receive(sendblue, { message, target: { phone }, auth: appAuth });
}

async function releaseClaims(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await supabase.from("flight_watches").update({ checked_on: null }).in("id", ids);
}

/**
 * Tell the owner the quota ran out — at most once per billing cycle. Keyed on
 * the plan renewal date so a month-long outage is one text, not thirty, with no
 * extra table and no extra cron. The winning upsert is the claim.
 */
async function notifyQuotaOnce(
  receive: Receive,
  appAuth: ScheduleHandlerArgs["appAuth"],
  renewalDate: string,
): Promise<void> {
  const key = `flights:quota_notice:${renewalDate || ownerToday().slice(0, 7)}`;
  const { data } = await supabase
    .from("channel_state")
    .upsert(
      { key, value: { notified_at: new Date().toISOString() }, updated_at: new Date().toISOString() },
      { onConflict: "key", ignoreDuplicates: true },
    )
    .select("key");
  if (!data || data.length === 0) return; // already told him this cycle

  const phone = process.env.OWNER_PHONE;
  if (!phone) return;
  await receive(sendblue, {
    message:
      "Your flight price checks have run out for this billing cycle" +
      (renewalDate ? `, and reset on ${renewalDate}` : "") +
      ". Flight watches are paused until then. Tell the owner in one short sentence, and offer " +
      "to cancel a watch or two if he wants the next cycle to stretch further.",
    target: { phone },
    auth: appAuth,
  });
}

export default defineSchedule({
  cron: "0 * * * *",
  async run({ receive, appAuth }) {
    if (
      !process.env.SERPAPI_API_KEY ||
      !process.env.SUPABASE_URL ||
      !process.env.SUPABASE_SECRET_KEY
    ) {
      console.warn("[flight-poll] SerpAPI / Supabase env not set; skipping");
      return;
    }
    // Load any travel override before any clock is read; see primeOwnerTimezone.
    await primeOwnerTimezone();
    if (ownerLocalHour() !== pollHour()) return;

    const today = ownerToday();
    const nowIso = new Date().toISOString();

    // --- 1. Expire watches whose departure is upon us. Free, so it runs first.
    // Two days early: fares stop being actionable and start climbing, and a
    // search for a past date is a BILLED no-op.
    const { data: expired, error: expireErr } = await supabase
      .from("flight_watches")
      .update({ status: "expired" })
      .eq("status", "active")
      .lt("outbound_date", addDays(today, EXPIRE_DAYS_BEFORE))
      .select("channel, phone, slack_target, origin_id, destination_id, outbound_date, return_date, baseline_price, last_price");
    if (expireErr) console.error(`[flight-poll] expire sweep failed: ${expireErr.message}`);

    if (expired && expired.length > 0) {
      console.log(`[flight-poll] expired ${expired.length} watch(es) nearing departure`);
      const lines = expired.map((w) => {
        const last = w.last_price as number | null;
        const base = w.baseline_price as number | null;
        return (
          `${routeLabel(w.origin_id as string, w.destination_id as string)} ` +
          `(${formatTripDates(w.outbound_date as string, w.return_date as string | null)})` +
          (last !== null ? ` — last seen ${formatUsd(last)}` : "") +
          (base !== null && last !== null && last !== base
            ? `, started at ${formatUsd(base)}`
            : "")
        );
      });
      try {
        await dispatch(
          receive,
          appAuth,
          expired[0] as Pick<FlightWatchRow, "channel" | "phone" | "slack_target">,
          `These flight watches just aged out because departure is nearly here, and you've stopped ` +
            `checking them: ${lines.join("; ")}. Let the owner know in one short line so they don't ` +
            `just vanish on him. Use ONLY these numbers.`,
        );
      } catch (err) {
        console.error("[flight-poll] expiry notice failed", err);
      }
    }

    // --- 2. Claim. checked_on is in both the SET and the WHERE, so a duplicate
    // invocation gets zero rows and spends nothing.
    const { data: claimed, error: claimErr } = await supabase
      .from("flight_watches")
      .update({ checked_on: today })
      .eq("status", "active")
      .gte("outbound_date", today)
      .or(`checked_on.is.null,checked_on.lt.${today}`)
      .select(WATCH_COLUMNS);
    if (claimErr) throw new Error(`[flight-poll] claim failed: ${claimErr.message}`);

    const due = (claimed ?? []) as unknown as FlightWatchRow[];
    if (due.length === 0) return;

    // --- 3. Quota preflight. The /account endpoint is free and uncounted.
    const quota = await accountQuota().catch((err) => {
      console.warn("[flight-poll] quota preflight failed, proceeding", err);
      return null;
    });
    let toCheck = due;
    if (quota) {
      if (quota.totalSearchesLeft <= QUOTA_RESERVE) {
        // Hold the last credits back: the owner asking "what's the fare now?"
        // is worth more than a background check.
        console.warn(
          `[flight-poll] only ${quota.totalSearchesLeft} searches left; reserving them for questions`,
        );
        await releaseClaims(due.map((w) => w.id));
        await notifyQuotaOnce(receive, appAuth, quota.planRenewalDate);
        return;
      }
      const budget = quota.totalSearchesLeft - QUOTA_RESERVE;
      if (budget < due.length) {
        // Soonest departures win — they're the ones he can still act on.
        const ordered = [...due].sort((a, b) => a.outbound_date.localeCompare(b.outbound_date));
        toCheck = ordered.slice(0, budget);
        await releaseClaims(ordered.slice(budget).map((w) => w.id));
        console.warn(`[flight-poll] budget ${budget}: checking ${toCheck.length} of ${due.length}`);
      }
    }

    // --- 4. Check each watch. try/catch INSIDE the loop: one unguarded field
    // access would otherwise kill every remaining watch for the day, and Vercel
    // does not retry a failed cron.
    const alerts: { watch: FlightWatchRow; line: string }[] = [];
    let checked = 0;
    let errors = 0;

    for (let i = 0; i < toCheck.length; i++) {
      const w = toCheck[i];
      let result;
      try {
        result = await searchFlights({
          departureId: w.origin_id,
          arrivalId: w.destination_id,
          outboundDate: w.outbound_date,
          returnDate: w.return_date,
          adults: w.adults,
          travelClass: w.travel_class,
          stops: w.stops,
          // Re-checks must reproduce the ORIGINAL query, or the daily price is
          // for a different question than the one the owner asked.
          includeAirlines: w.include_airlines,
        });
      } catch (err) {
        if (err instanceof FlightSearchError && err.kind === "quota") {
          // Global, not per-watch: stop the run and give back what we haven't spent.
          await releaseClaims(toCheck.slice(i).map((x) => x.id));
          await notifyQuotaOnce(receive, appAuth, quota?.planRenewalDate ?? "");
          console.warn("[flight-poll] quota exhausted mid-run; stopping");
          break;
        }
        errors++;
        const failures = w.consecutive_errors + 1;
        // The claim is NOT released. A missed check self-heals tomorrow, and
        // retrying today would re-spend a credit on a query that may well have
        // succeeded server-side.
        await supabase
          .from("flight_watches")
          .update({
            last_error: String((err as Error).message).slice(0, 300),
            consecutive_errors: failures,
            last_checked_at: nowIso,
            // Three strikes: a typo'd route otherwise burns 12% of the free
            // tier every month, producing nothing, invisibly.
            ...(failures >= 3
              ? { status: "paused", paused_reason: "3 consecutive failed price checks" }
              : {}),
          })
          .eq("id", w.id);
        console.error(`[flight-poll] search failed for ${w.id} (${failures} in a row)`, err);
        continue;
      }

      checked++;
      const price = result.cheapestPrice;
      if (price === null) {
        // A silent route is not news — record it, never text about it.
        await supabase
          .from("flight_watches")
          .update({
            last_error: "no itineraries returned",
            consecutive_errors: w.consecutive_errors + 1,
            last_checked_at: nowIso,
          })
          .eq("id", w.id);
        continue;
      }

      const decision = evaluateAlert({
        currentPrice: price,
        lastPrice: w.last_price,
        alertedPrice: w.alerted_price,
        alertedAt: w.alerted_at,
        targetPrice: w.target_price,
        baselinePrice: w.baseline_price,
        typicalRange: result.insights?.typicalRange ?? null,
      });

      // Write the observed price AND claim the alert in one update, before any
      // dispatch. Guarded on the alerted_price we read, so a concurrent run
      // can't double-claim.
      let update = supabase
        .from("flight_watches")
        .update({
          last_price: price,
          last_price_at: nowIso,
          last_checked_at: nowIso,
          last_error: null,
          consecutive_errors: 0,
          ...(decision.alert
            ? { alerted_price: price, alerted_at: nowIso }
            : decision.rearm
              ? { alerted_price: null }
              : {}),
        })
        .eq("id", w.id);
      update =
        w.alerted_price === null
          ? update.is("alerted_price", null)
          : update.eq("alerted_price", w.alerted_price);
      const { data: won } = await update.select("id").maybeSingle();

      if (!decision.alert) {
        console.log(
          `[flight-poll] ${w.origin_id}→${w.destination_id} ${formatUsd(price)} — no alert` +
            (decision.suppressed ? ` (${decision.suppressedBy})` : ""),
        );
        continue;
      }
      if (!won) {
        console.warn(`[flight-poll] lost the alert claim for ${w.id}; skipping`);
        continue;
      }

      // Everything the model is allowed to say is assembled here. A vague
      // prompt makes it either invent fares or call search_flights again — and
      // a hallucinated fare is the one error the owner acts on and loses money.
      const insights = result.insights;
      alerts.push({
        watch: w,
        line:
          `${routeLabel(w.origin_id, w.destination_id)} ` +
          `(${formatTripDates(w.outbound_date, w.return_date)}, ` +
          `${w.return_date ? "round trip" : "one way"}` +
          `${w.adults > 1 ? `, ${w.adults} travelers` : ""}) is now ${formatUsd(price)} — ` +
          `${decision.headline}.` +
          (insights?.typicalRange
            ? ` Google's typical range for this route is ${formatUsd(insights.typicalRange[0])}–${formatUsd(insights.typicalRange[1])}.`
            : "") +
          (insights?.priceLevel === "low" ? " Google rates it a low fare." : "") +
          (w.baseline_price !== null
            ? ` It was ${formatUsd(w.baseline_price)} when tracking started.`
            : "") +
          (result.cheapest
            ? ` Cheapest option: ${summarizeItinerary(result.cheapest)}` +
              `${w.return_date ? " (that's the outbound leg; the price is the full round trip)" : ""}.`
            : "") +
          ` Link: ${result.googleFlightsUrl} . Watch id ${w.id}.`,
      });
    }

    // --- 5. One dispatch for the whole batch. Six separate ones would be six
    // sessions, six model turns and six texts. (sendblue-poll splits messages
    // on purpose, but that's about eve's HITL approve/deny matching on INBOUND
    // text, which doesn't apply to a proactive outbound alert.)
    if (alerts.length > 0) {
      const body =
        alerts.length === 1
          ? `Flight price alert for a route you're tracking for the owner: ${alerts[0].line}`
          : `Flight price alerts for ${alerts.length} routes you're tracking for the owner: ` +
            alerts.map((a, n) => `(${n + 1}) ${a.line}`).join(" ");
      const prompt =
        `${body} Text him a short, natural heads-up — the price, one clause on why it's worth ` +
        `knowing, and the link. Two sentences per route at most, no itinerary dumps, and don't ` +
        `promise the fare will hold. Use ONLY the numbers above: do NOT call search_flights, and ` +
        `do not state any price, airline or time that isn't listed here. If he says to stop ` +
        `watching one, cancel it with cancel_flight_watch using the watch id given.`;
      try {
        await dispatch(receive, appAuth, alerts[0].watch, prompt);
      } catch (err) {
        console.error("[flight-poll] alert dispatch failed", err);
        // Revert only the alert claim — the observed price stands — so the next
        // run can re-alert. No immediate retry: the next attempt is 24h out,
        // which is right for a price alert and avoids a retry storm.
        for (const a of alerts) {
          await supabase
            .from("flight_watches")
            .update({ alerted_price: a.watch.alerted_price, alerted_at: a.watch.alerted_at })
            .eq("id", a.watch.id);
        }
      }
    }

    console.log(`[flight-poll] checked ${checked}, alerted ${alerts.length}, errors ${errors}`);
  },
});
