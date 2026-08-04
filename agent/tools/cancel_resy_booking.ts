import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { ResyError, cancelBooking, redact } from "#lib/resy.js";
import { ensureResyStore } from "#lib/resy-store.js";
import { supabase } from "#lib/supabase.js";

export default defineTool({
  description:
    "Cancel a reservation the owner actually holds. REQUIRES his explicit approval. Give it the " +
    "resyToken from book_resy, from list_resy_snipes on a won snipe, or from list_resy_bookings. " +
    "Some venues charge a cancellation fee — say so if you know, and never cancel on your own " +
    "initiative. Prefer this over a no-show: it gives the table back and no-shows are what get " +
    "Resy accounts suspended.",
  inputSchema: z.object({
    resyToken: z.string().min(1).describe("Reservation handle, not a venue id"),
  }),
  approval: always(),
  async execute({ resyToken }) {
    ensureResyStore();
    try {
      await cancelBooking(resyToken);
    } catch (err) {
      if (err instanceof ResyError && err.kind === "gone") {
        return {
          ok: false as const,
          error: "Resy says that reservation doesn't exist — it may already have been cancelled.",
        };
      }
      const message = err instanceof ResyError ? err.message : redact(String(err));
      return { ok: false as const, error: message };
    }

    // Keep our own record honest. Best-effort: the table IS released at this
    // point, and reporting failure because of a bookkeeping update would tell
    // the owner the opposite of what happened.
    const { error } = await supabase
      .from("resy_snipes")
      .update({ status: "cancelled", updated_at: new Date().toISOString() })
      .eq("resy_token", resyToken);
    if (error) console.warn("[resy] cancelled booking but couldn't update snipe row:", error.message);

    return { ok: true as const, cancelled: true };
  },
});
