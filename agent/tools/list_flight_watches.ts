import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  MAX_ACTIVE_WATCHES,
  accountQuota,
  cabinFromCode,
  daysBetween,
  formatTripDates,
  formatUsd,
  ownerToday,
  routeLabel,
  type FlightWatchRow,
} from "#lib/flights.js";
import { formatLocal, primeOwnerTimezone } from "#lib/reminders.js";
import { supabase } from "#lib/supabase.js";

/**
 * The subset of flight_watches this tool reads. Declared explicitly because
 * supabase-js infers row types from the `select()` STRING LITERAL, and the
 * column list below is long enough to need concatenating — which defeats that
 * inference and yields GenericStringError.
 */
type WatchListRow = Pick<
  FlightWatchRow,
  | "id"
  | "origin_query"
  | "destination_query"
  | "origin_id"
  | "destination_id"
  | "outbound_date"
  | "return_date"
  | "adults"
  | "travel_class"
  | "stops"
  | "include_airlines"
  | "target_price"
  | "baseline_price"
  | "last_price"
  | "last_checked_at"
  | "last_error"
  | "status"
  | "paused_reason"
>;

export default defineTool({
  description:
    "List the owner's flight price watches — route, dates, today's price, how it's moved since " +
    "he started tracking, and any target price. Use this before track_flight when the 6-watch " +
    "cap is hit, and to get ids for cancel_flight_watch. Also reports how many searches are left " +
    "this month. Reading this list is FREE — it does not re-price anything.",
  inputSchema: z.object({
    includeInactive: z
      .boolean()
      .optional()
      .describe("Also show cancelled, paused and expired watches; default false"),
  }),
  async execute({ includeInactive }) {
    // Tools run in their own workflow step, not in the invocation that primed
    // the zone at ingress, so the cache is cold here. See primeOwnerTimezone.
    await primeOwnerTimezone();
    const statuses = includeInactive
      ? ["active", "paused", "expired", "cancelled"]
      : ["active", "paused"];
    const { data, error } = await supabase
      .from("flight_watches")
      .select(
        "id, origin_query, destination_query, origin_id, destination_id, outbound_date, " +
          "return_date, adults, travel_class, stops, include_airlines, target_price, " +
          "baseline_price, last_price, " +
          "last_checked_at, last_error, status, paused_reason",
      )
      .in("status", statuses)
      .order("outbound_date", { ascending: true })
      .limit(20);
    if (error) return { ok: false as const, error: error.message };

    // Free endpoint, and best-effort: never fail the listing over it.
    const quota = await accountQuota().catch(() => null);
    const today = ownerToday();
    const rows = (data ?? []) as unknown as WatchListRow[];

    return {
      ok: true as const,
      activeCount: rows.filter((r) => r.status === "active").length,
      maxActive: MAX_ACTIVE_WATCHES,
      searchesLeftThisMonth: quota?.totalSearchesLeft ?? null,
      watches: rows.map((r) => {
        const change =
          r.baseline_price !== null && r.last_price !== null
            ? r.last_price - r.baseline_price
            : null;
        return {
          id: r.id,
          // Both forms, so a wrong airport resolution is visible with no API call.
          route: routeLabel(r.origin_id, r.destination_id),
          spokenAs: `${r.origin_query} → ${r.destination_query}`,
          dates: formatTripDates(r.outbound_date, r.return_date),
          passengers: r.adults,
          cabin: cabinFromCode(r.travel_class),
          nonstopOnly: r.stops === 1,
          airlines: r.include_airlines ?? undefined,
          currentPrice: r.last_price !== null ? formatUsd(r.last_price) : "not checked yet",
          sinceTracking:
            change === null
              ? undefined
              : change === 0
                ? "unchanged since tracking started"
                : `${change < 0 ? "down" : "up"} ${formatUsd(Math.abs(change))} since tracking started`,
          targetPrice: r.target_price !== null ? formatUsd(r.target_price) : undefined,
          daysUntilDeparture: daysBetween(today, r.outbound_date),
          lastChecked: r.last_checked_at ? formatLocal(r.last_checked_at) : "never",
          problem: r.paused_reason ?? r.last_error ?? undefined,
          status: r.status,
        };
      }),
    };
  },
});
