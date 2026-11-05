import { defineTool } from "eve/tools";
import { z } from "zod";
import { listPlaces } from "#lib/location.js";
import { formatLocal, primeOwnerTimezone } from "#lib/reminders.js";

export default defineTool({
  description:
    "What his phone last reported about each place it watches (home, work, …): arrived or " +
    "left, and when. Use for 'am I home?', 'when did I get home?', or to check which places " +
    "can trigger location reminders. Only places with an iPhone Shortcuts automation appear; " +
    "it is the last arrive/leave ping, not live GPS — say so if it's stale.",
  inputSchema: z.object({}),
  async execute() {
    await primeOwnerTimezone();
    try {
      const places = await listPlaces();
      const latest = places.find((p) => p.last_event_at) ?? null;
      return {
        ok: true as const,
        // The most recent ping is the best guess at where he is now.
        lastKnown: latest
          ? {
              place: latest.key,
              event: latest.last_event,
              at: formatLocal(latest.last_event_at!),
            }
          : null,
        places: places.map((p) => ({
          place: p.key,
          lastEvent: p.last_event,
          at: p.last_event_at ? formatLocal(p.last_event_at) : null,
        })),
      };
    } catch (err) {
      return { ok: false as const, error: (err as Error).message };
    }
  },
});
