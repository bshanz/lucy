import { defineTool } from "eve/tools";
import { z } from "zod";
import { supabase } from "#lib/supabase.js";

export default defineTool({
  description:
    "Disarm a snipe that hasn't fired yet, by id from list_resy_snipes. This only stops a " +
    "FUTURE automatic booking — it does NOT cancel a table that was already won. For a " +
    "reservation Lucy actually booked, use cancel_resy_booking instead.",
  inputSchema: z.object({
    id: z.string().uuid().describe("Snipe id from list_resy_snipes"),
  }),
  async execute({ id }) {
    // Only 'armed' is cancellable. 'firing' means the drop race is live right
    // now: the row is already claimed and a booking may be seconds from
    // committing, so flipping status here would leave a real reservation with
    // no record of who owns it. Refuse and let it finish.
    const { data, error } = await supabase
      .from("resy_snipes")
      .update({ status: "cancelled", updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("status", "armed")
      .select("venue_name, reservation_date, party_size")
      .maybeSingle();

    if (error) return { ok: false as const, error: error.message };

    if (!data) {
      const { data: existing } = await supabase
        .from("resy_snipes")
        .select("status, venue_name")
        .eq("id", id)
        .maybeSingle();

      if (!existing) return { ok: false as const, error: `No snipe with id ${id}.` };
      if (existing.status === "firing") {
        return {
          ok: false as const,
          error:
            `That snipe for ${existing.venue_name} is booking right now — I can't stop it ` +
            `mid-flight. Wait a moment for the result; if it wins and he doesn't want the ` +
            `table, cancel the reservation with cancel_resy_booking.`,
        };
      }
      if (existing.status === "booked") {
        return {
          ok: false as const,
          error:
            `That one already won a table at ${existing.venue_name}. Cancelling the snipe would ` +
            `do nothing. If he wants to give the table back, use cancel_resy_booking.`,
        };
      }
      return {
        ok: false as const,
        error: `That snipe is already ${existing.status} — nothing to cancel.`,
      };
    }

    return {
      ok: true as const,
      cancelled: `${data.venue_name} on ${data.reservation_date} for ${data.party_size}`,
    };
  },
});
