import { defineTool } from "eve/tools";
import { z } from "zod";
import { formatTripDates, routeLabel } from "#lib/flights.js";
import { supabase } from "#lib/supabase.js";

export default defineTool({
  description:
    "Stop watching a flight route (get ids from list_flight_watches). Frees a slot against the " +
    "6-watch maximum. Keeps the history — it just stops the daily price checks and the alerts.",
  inputSchema: z.object({
    id: z.string().uuid().describe("The flight watch id to cancel"),
  }),
  async execute({ id }) {
    // Guard in the filter, not in a branch: a watch that is already expired or
    // cancelled simply matches nothing.
    const { data, error } = await supabase
      .from("flight_watches")
      .update({ status: "cancelled" })
      .eq("id", id)
      .in("status", ["active", "paused"])
      .select("origin_id, destination_id, outbound_date, return_date")
      .maybeSingle();
    if (error) return { ok: false as const, error: error.message };
    if (!data) {
      return {
        ok: false as const,
        error: "No active flight watch with that id — call list_flight_watches for the current ids.",
      };
    }
    return {
      ok: true as const,
      cancelled:
        `${routeLabel(data.origin_id as string, data.destination_id as string)}, ` +
        `${formatTripDates(data.outbound_date as string, data.return_date as string | null)}`,
    };
  },
});
