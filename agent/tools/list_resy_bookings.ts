import { defineTool } from "eve/tools";
import { z } from "zod";
import { ResyError, formatTime, myReservations, notConnectedMessage, redact } from "#lib/resy.js";
import { ensureResyStore } from "#lib/resy-store.js";

export default defineTool({
  description:
    "List the reservations the owner currently holds on Resy — the real ones, straight from his " +
    "account, including any Lucy booked. Use for 'what do I have booked?', to check before " +
    "booking something that might clash, and to get the resyToken needed by cancel_resy_booking.",
  inputSchema: z.object({}),
  async execute() {
    ensureResyStore();
    try {
      const reservations = await myReservations();
      return {
        ok: true as const,
        count: reservations.length,
        reservations: reservations.map((r) => ({
          venue: r.venueName,
          date: r.day,
          time: r.time ? formatTime(r.time) : null,
          partySize: r.partySize,
          resyToken: r.resyToken,
        })),
      };
    } catch (err) {
      if (
        err instanceof ResyError &&
        (err.kind === "not_configured" || err.kind === "needs_login")
      ) {
        return { ok: false as const, error: notConnectedMessage(err.kind) };
      }
      const message = err instanceof ResyError ? err.message : redact(String(err));
      return { ok: false as const, error: message };
    }
  },
});
