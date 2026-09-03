import { defineTool } from "eve/tools";
import { z } from "zod";
import { formatTime, formatUsd, hhmm, type ResySnipeRow } from "#lib/resy.js";
import { formatLocal, primeOwnerTimezone } from "#lib/reminders.js";
import { supabase } from "#lib/supabase.js";

export default defineTool({
  description:
    "Show the owner's Resy snipes — what's armed and waiting, and recently what was won or " +
    "missed. Use when he asks what you're watching, and before cancel_resy_snipe so you can " +
    "quote the right one back to him.",
  inputSchema: z.object({
    includeFinished: z
      .boolean()
      .optional()
      .describe("Also show booked/missed/failed/cancelled from the last 30 days. Default false."),
  }),
  async execute({ includeFinished }) {
    // Tools run in their own workflow step, not in the invocation that primed
    // the zone at ingress, so the cache is cold here. See primeOwnerTimezone.
    await primeOwnerTimezone();
    const base = supabase.from("resy_snipes").select("*");

    // Filters must precede .order()/.returns() — the transform builder drops
    // them from the type once ordering is applied.
    const filtered = includeFinished
      ? base.gte("created_at", new Date(Date.now() - 30 * 86400_000).toISOString())
      : base.in("status", ["armed", "firing"]);

    const { data, error } = await filtered
      .order("drop_at", { ascending: true })
      .returns<ResySnipeRow[]>();
    if (error) return { ok: false as const, error: error.message };

    return {
      ok: true as const,
      count: data.length,
      snipes: data.map((s) => ({
        id: s.id,
        venue: s.venue_name,
        date: s.reservation_date,
        partySize: s.party_size,
        // "4, or 2 if nothing opens" is a materially different standing order
        // from "4" — he should hear it when he asks what's armed.
        fallbackPartySize: s.fallback_party_size,
        window: `${formatTime(hhmm(s.earliest_time))}–${formatTime(hhmm(s.latest_time))}`,
        preferred: s.preferred_time ? formatTime(hhmm(s.preferred_time)) : null,
        maxDeposit: s.max_deposit_cents ? formatUsd(s.max_deposit_cents) : "none",
        // One of two shapes. A precise drop is a moment; a watch is a window
        // Lucy sits across because the venue's release time isn't known. Say
        // which it is — "watching 8–11am" and "fires at 9:00" set very
        // different expectations about how exact this is.
        dropsAt: s.drop_at ? formatLocal(s.drop_at) : null,
        watching:
          s.watch_from && s.watch_until
            ? `${formatLocal(s.watch_from)} until ${formatLocal(s.watch_until)}`
            : null,
        status: s.status,
        // Only present once it has fired. Quote these rather than paraphrasing —
        // "you got 7:45 in the dining room" is the whole point of the feature.
        bookedTime: s.booked_time ? formatTime(hhmm(s.booked_time)) : null,
        bookedTable: s.booked_slot_type,
        bookedPartySize: s.booked_party_size,
        depositPaid: s.deposit_paid_cents ? formatUsd(s.deposit_paid_cents) : null,
        lastError: s.last_error,
      })),
    };
  },
});
