import { defineTool } from "eve/tools";
import { z } from "zod";
import { ResyError, redact, snipeBlocker, venueSearch } from "#lib/resy.js";

export default defineTool({
  description:
    "Find a restaurant on Resy by name (optionally with a city) and return its venue id plus " +
    "the constraints that decide whether it can be booked automatically. ALWAYS call this " +
    "first — every other Resy tool takes a venue id, and you must never ask the owner for one. " +
    "Say which venue you picked ('Carbone in NYC, not the Miami one') so he can correct you. " +
    "Unauthenticated and cheap; call it freely.",
  inputSchema: z.object({
    query: z
      .string()
      .min(2)
      .describe("Restaurant name, optionally with city: 'Carbone' or 'Carbone Miami'"),
    limit: z.number().int().min(1).max(10).optional().describe("How many matches, default 5"),
  }),
  async execute({ query, limit }) {
    let venues;
    try {
      venues = await venueSearch(query, limit ?? 5);
    } catch (err) {
      const message = err instanceof ResyError ? err.message : redact(String(err));
      return { ok: false as const, error: message };
    }

    if (venues.length === 0) {
      return {
        ok: false as const,
        error:
          `Nothing on Resy matches "${query}". It may not use Resy at all (plenty of good ` +
          `restaurants are on Tock, OpenTable, or take walk-ins only). Tell the owner that ` +
          `rather than guessing at a different restaurant.`,
      };
    }

    return {
      ok: true as const,
      venues: venues.map((v) => ({
        venueId: v.id,
        name: v.name,
        city: v.city,
        neighborhood: v.neighborhood,
        cuisine: v.cuisine,
        maxPartySize: v.maxPartySize,
        // Surfaced per-venue because it genuinely varies between locations of
        // the same restaurant — Carbone NYC can be sniped, Carbone Miami can't.
        // Checking it here saves arming a snipe that would die at drop time.
        canAutoBook: snipeBlocker(v, 1) === null,
        autoBookBlockedBecause: snipeBlocker(v, 1),
      })),
    };
  },
});
