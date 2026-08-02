import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  MAX_INTERACTIVE_PER_DAY,
  cabinToCode,
  checkRoute,
  describeStops,
  flightErrorMessage,
  formatDuration,
  formatTripDates,
  formatUsd,
  ownerToday,
  resolveAirlines,
  routeLabel,
  searchFlights,
} from "#lib/flights.js";
import { supabase } from "#lib/supabase.js";

export default defineTool({
  description:
    "Price a flight right now with Google Flights. Airports are 3-letter IATA codes — translate " +
    "what the owner says yourself (Lisbon → LIS, London → LHR,LGW,STN, New York → JFK,EWR,LGA) " +
    "and never ask him for a code; comma-separate up to 4 for a city. Dates are YYYY-MM-DD; omit " +
    "returnDate for one-way. Prices are USD and are the TOTAL fare — a round-trip price covers " +
    "both legs, but the itinerary shown is the outbound leg only. If the owner names a carrier " +
    "(\"United nonstop\"), pass it as `airlines` — do NOT drop it and answer for all carriers. " +
    "SEARCHES ARE METERED (250 a " +
    "month, shared with price tracking): one search per question, and never sweep a dozen dates. " +
    "For ongoing monitoring use track_flight instead — this is a one-off look.",
  inputSchema: z.object({
    from: z.string().min(3).describe("Origin: IATA code(s) like 'JFK' or 'JFK,EWR,LGA'"),
    to: z.string().min(3).describe("Destination: IATA code(s) like 'LIS'"),
    outboundDate: z.string().describe("Departure date, YYYY-MM-DD"),
    returnDate: z.string().optional().describe("Return date, YYYY-MM-DD; omit for one-way"),
    adults: z.number().int().min(1).max(9).optional().describe("Default 1"),
    cabin: z
      .enum(["economy", "premium_economy", "business", "first"])
      .optional()
      .describe("Default economy"),
    nonstopOnly: z.boolean().optional().describe("Only nonstop itineraries"),
    airlines: z
      .string()
      .optional()
      .describe(
        "Restrict to specific carriers when the owner names one — airline name or 2-letter " +
          "IATA code, comma-separated ('United', 'UA', 'United,Delta'). Alliances work too " +
          "('Star Alliance'). Omit for all carriers.",
      ),
    maxPrice: z.number().int().min(1).optional().describe("USD ceiling"),
  }),
  async execute(input) {
    const route = checkRoute(input);
    if (!route.ok) return { ok: false as const, error: route.error };

    // Refuse rather than silently drop the constraint: an unfiltered result set
    // looks like a perfectly good answer to a question it doesn't answer.
    const includeAirlines = input.airlines ? resolveAirlines(input.airlines) : null;
    if (input.airlines && !includeAirlines) {
      return {
        ok: false as const,
        error:
          `Didn't recognise the airline "${input.airlines}". Pass a 2-letter IATA code ` +
          `(United → UA, JetBlue → B6, Delta → DL) or an alliance name, then retry.`,
      };
    }

    // Soft daily budget. Interactive lookups are what actually drain the quota —
    // left unbounded the model will happily explore four dates in one answer.
    const counterKey = `flights:searches:${ownerToday()}`;
    const { data: counter } = await supabase
      .from("channel_state")
      .select("value")
      .eq("key", counterKey)
      .maybeSingle();
    const usedToday = Number((counter?.value as { count?: number } | null)?.count ?? 0);
    if (usedToday >= MAX_INTERACTIVE_PER_DAY) {
      return {
        ok: false as const,
        error:
          `That's ${usedToday} flight searches today, which is the daily limit that keeps the ` +
          `monthly quota alive. Tell the owner, and ask him for one specific date instead of a range.`,
      };
    }

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
        maxPrice: input.maxPrice,
        includeAirlines,
      });
    } catch (err) {
      return { ok: false as const, error: flightErrorMessage(err) };
    }

    await supabase
      .from("channel_state")
      .upsert(
        { key: counterKey, value: { count: usedToday + 1 }, updated_at: new Date().toISOString() },
        { onConflict: "key" },
      );

    if (result.cheapestPrice === null) {
      return {
        ok: false as const,
        error:
          "No itineraries came back for that route and date. Check the codes and the date, then " +
          "try once more with a single primary airport or a nearby date.",
      };
    }

    const insights = result.insights;
    return {
      ok: true as const,
      route: routeLabel(route.originId, route.destinationId),
      dates: formatTripDates(input.outboundDate, input.returnDate ?? null),
      tripType: result.tripType === "round_trip" ? "round trip" : "one way",
      // Echoed so the reply can state the filters actually applied — the owner
      // needs to know whether "United nonstop" was honoured or widened.
      filters: {
        nonstopOnly: input.nonstopOnly === true,
        airlines: includeAirlines,
      },
      cheapestPrice: formatUsd(result.cheapestPrice),
      // Google's own read of the route — this is what makes a bare number mean
      // something without any accumulated price history of our own.
      priceRead: insights
        ? {
            level: insights.priceLevel,
            typicalRange: insights.typicalRange
              ? `${formatUsd(insights.typicalRange[0])}–${formatUsd(insights.typicalRange[1])}`
              : null,
          }
        : null,
      // Projected down hard: a raw Google Flights response is dozens of
      // itineraries x segments x layovers x carbon data.
      options: result.options.slice(0, 3).map((f) => ({
        price: formatUsd(f.price),
        airlines: [...new Set(f.segments.map((s) => s.airline))].join(" / "),
        departsFrom: f.segments[0]?.from.id ?? null,
        arrivesAt: f.segments.at(-1)?.to.id ?? null,
        duration: formatDuration(f.totalDurationMinutes),
        stops: describeStops(f),
      })),
      note: input.returnDate
        ? "Round trip: the price is the full round-trip fare; the itinerary shown is the outbound leg."
        : undefined,
      link: result.googleFlightsUrl,
      searchesUsedToday: usedToday + 1,
    };
  },
});
