import { defineTool } from "eve/tools";
import { z } from "zod";
import { ResyError, findSlots, formatTime, notConnectedMessage, redact } from "#lib/resy.js";
import { ensureResyStore } from "#lib/resy-store.js";

export default defineTool({
  description:
    "List the tables open RIGHT NOW at one venue on one date for a given party size. Use this " +
    "to answer 'can we get into X on Friday?'. Get the venueId from search_resy first — never " +
    "ask the owner for it. Date is YYYY-MM-DD and you resolve it yourself from the current time " +
    "in your context. An empty list means the night is booked out, NOT that the restaurant is " +
    "closed — if he wants it anyway, that's what snipe_resy is for on the next drop.",
  inputSchema: z.object({
    venueId: z.number().int().positive().describe("From search_resy"),
    date: z.string().describe("YYYY-MM-DD, a specific day"),
    partySize: z.number().int().min(1).max(20).describe("Number of people"),
  }),
  async execute({ venueId, date, partySize }) {
    ensureResyStore();

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return { ok: false as const, error: `Date must be YYYY-MM-DD, got "${date}".` };
    }

    let slots;
    try {
      slots = await findSlots({ venueId, day: date, partySize });
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

    return {
      ok: true as const,
      venueId,
      date,
      partySize,
      count: slots.length,
      slots: slots.map((s) => ({
        time: formatTime(s.time),
        time24: s.time,
        type: s.type,
        // The handle book_resy needs. Opaque and not secret — it encodes the
        // venue, service, date and party size, nothing about the owner.
        configToken: s.configToken,
      })),
    };
  },
});
