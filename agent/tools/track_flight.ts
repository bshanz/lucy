import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  MAX_ACTIVE_WATCHES,
  cabinToCode,
  checkRoute,
  flightErrorMessage,
  formatTripDates,
  formatUsd,
  ownerToday,
  routeLabel,
  searchFlights,
  summarizeItinerary,
} from "#lib/flights.js";
import { supabase } from "#lib/supabase.js";

export default defineTool({
  description:
    "Start watching a route for price drops. Lucy re-checks it once a day and texts the owner " +
    "unprompted only when the fare is genuinely notable — below Google's typical range, " +
    "meaningfully cheaper than the last check, or at/under targetPrice. Prices the route " +
    "immediately and returns today's fare: report that in your confirmation. Same airport and " +
    "date rules as search_flights (IATA codes you translate yourself, YYYY-MM-DD). MAXIMUM 6 " +
    "ACTIVE WATCHES — each one spends about 30 of the 250 monthly searches. If it's full this " +
    "returns an error: call list_flight_watches, ask the owner which to drop, cancel it, then " +
    "retry. Alerts fire on whichever channel he asked from.",
  inputSchema: z.object({
    from: z.string().min(3).describe("Origin: IATA code(s) like 'JFK' or 'JFK,EWR,LGA'"),
    to: z.string().min(3).describe("Destination: IATA code(s) like 'LIS'"),
    outboundDate: z.string().describe("Departure date, YYYY-MM-DD. Must be a specific day, not a month"),
    returnDate: z.string().optional().describe("Return date, YYYY-MM-DD; omit for one-way"),
    adults: z.number().int().min(1).max(9).optional().describe("Default 1"),
    cabin: z
      .enum(["economy", "premium_economy", "business", "first"])
      .optional()
      .describe("Default economy"),
    nonstopOnly: z.boolean().optional().describe("Only nonstop itineraries"),
    targetPrice: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("USD price to alert at — 'tell me if it goes under $500' → 500"),
  }),
  async execute(input, ctx) {
    const route = checkRoute(input);
    if (!route.ok) return { ok: false as const, error: route.error };

    // 1. Cap check, BEFORE anything metered runs.
    const { count, error: countError } = await supabase
      .from("flight_watches")
      .select("id", { count: "exact", head: true })
      .eq("status", "active");
    if (countError) return { ok: false as const, error: countError.message };
    if ((count ?? 0) >= MAX_ACTIVE_WATCHES) {
      return {
        ok: false as const,
        error:
          `Already tracking ${count} flights, which is the maximum (${MAX_ACTIVE_WATCHES}) — each ` +
          `watch spends about 30 of the 250 monthly price checks. Call list_flight_watches, show ` +
          `the owner what's there, ask which one to drop, cancel it with cancel_flight_watch, ` +
          `then call track_flight again. Do NOT retry without cancelling one first.`,
      };
    }

    // 2. Duplicate check — the partial unique index is the real guarantee, but
    //    catching it here produces a message the model can act on.
    let dupQuery = supabase
      .from("flight_watches")
      .select("id, target_price")
      .eq("status", "active")
      .eq("origin_id", route.originId)
      .eq("destination_id", route.destinationId)
      .eq("outbound_date", input.outboundDate);
    dupQuery = input.returnDate
      ? dupQuery.eq("return_date", input.returnDate)
      : dupQuery.is("return_date", null);
    const { data: dup } = await dupQuery.maybeSingle();
    if (dup) {
      return {
        ok: false as const,
        error:
          `Already tracking ${routeLabel(route.originId, route.destinationId)} on those dates ` +
          `(watch ${dup.id}). Tell the owner it's already covered. If he wants a different target ` +
          `price or cabin, cancel that watch first, then create a new one.`,
      };
    }

    // 3. Price it now. A route that returns nothing must NOT become a watch —
    //    it would burn ~30 billed searches a month producing silence.
    let result;
    try {
      result = await searchFlights({
        departureId: route.originId,
        arrivalId: route.destinationId,
        outboundDate: input.outboundDate,
        returnDate: input.returnDate ?? null,
        adults: input.adults,
        travelClass: input.cabin ? cabinToCode(input.cabin) : 1,
        stops: input.nonstopOnly ? 1 : 0,
      });
    } catch (err) {
      return { ok: false as const, error: flightErrorMessage(err) };
    }
    const price = result.cheapestPrice;
    if (price === null) {
      return {
        ok: false as const,
        error:
          "No flights came back for that route and date, so I won't start a watch that would " +
          "spend a search a day on nothing. Check the airport codes and the date first.",
      };
    }

    // 4. Delivery target comes from the verified session, never from the model.
    const attrs = ctx.session.auth.current?.attributes as
      | { channel?: string; phone?: string; slackChannelId?: string }
      | undefined;
    const channel = attrs?.channel === "slack" ? "slack" : "imessage";
    const phone = channel === "imessage" ? attrs?.phone ?? process.env.OWNER_PHONE ?? null : null;
    const slackTarget =
      channel === "slack" && attrs?.slackChannelId ? { channelId: attrs.slackChannelId } : null;
    if (channel === "imessage" && !phone) {
      return { ok: false as const, error: "No phone number configured (OWNER_PHONE missing)" };
    }
    if (channel === "slack" && !slackTarget) {
      return {
        ok: false as const,
        error: "Can't target Slack from here — ask the owner to request it from a Slack DM.",
      };
    }

    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from("flight_watches")
      .insert({
        channel,
        phone,
        slack_target: slackTarget,
        origin_query: input.from,
        destination_query: input.to,
        origin_id: route.originId,
        destination_id: route.destinationId,
        outbound_date: input.outboundDate,
        return_date: input.returnDate ?? null,
        adults: input.adults ?? 1,
        travel_class: input.cabin ? cabinToCode(input.cabin) : 1,
        stops: input.nonstopOnly ? 1 : 0,
        target_price: input.targetPrice ?? null,
        baseline_price: price,
        last_price: price,
        last_price_at: now,
        // Seed the alert state from this very search: the confirmation below is
        // about to quote this price, so tomorrow's poll must not re-announce it.
        alerted_price: price,
        alerted_at: now,
        // Claim today, so today's poll skips this row instead of paying twice.
        checked_on: ownerToday(),
        last_checked_at: now,
      })
      .select("id")
      .single();
    if (error) {
      if (error.code === "23505") {
        return {
          ok: false as const,
          error:
            `That route and date pair is already being tracked. Tell the owner it's already ` +
            `covered — call list_flight_watches if he wants to see it.`,
        };
      }
      return { ok: false as const, error: error.message };
    }

    const insights = result.insights;
    return {
      ok: true as const,
      id: data.id as string,
      route: routeLabel(route.originId, route.destinationId),
      dates: formatTripDates(input.outboundDate, input.returnDate ?? null),
      currentPrice: formatUsd(price),
      priceRead: insights
        ? {
            level: insights.priceLevel,
            typicalRange: insights.typicalRange
              ? `${formatUsd(insights.typicalRange[0])}–${formatUsd(insights.typicalRange[1])}`
              : null,
          }
        : null,
      targetPrice: input.targetPrice ? formatUsd(input.targetPrice) : null,
      cheapestOption: result.cheapest ? summarizeItinerary(result.cheapest) : null,
      link: result.googleFlightsUrl,
      activeWatches: (count ?? 0) + 1,
      maxWatches: MAX_ACTIVE_WATCHES,
    };
  },
});
