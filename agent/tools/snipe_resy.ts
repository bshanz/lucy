import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import {
  MAX_ACTIVE_SNIPES,
  ResyError,
  computeDropAt,
  dropAtForBookingWindow,
  formatTime,
  formatUsd,
  redact,
  snipeBlocker,
  venueLookup,
} from "#lib/resy.js";
import { ensureResyStore } from "#lib/resy-store.js";
import { formatLocal } from "#lib/reminders.js";
import { supabase } from "#lib/supabase.js";

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export default defineTool({
  description:
    "Arm an automatic booking for a table that isn't available yet. At the drop moment Lucy " +
    "books the best table inside the bounds set here, unattended, and texts the result. " +
    "REQUIRES the owner's explicit approval — he sees the venue, date, party size, time window " +
    "and deposit cap on a card first, and THAT CARD IS THE AUTHORIZATION for a real booking " +
    "with a real cancellation fee. Get venueId and venueName from search_resy first. " +
    "State the drop time back to him in his local time and get a clear yes. " +
    "If you KNOW the exact release time, give dropAtLocal (or daysAhead + dropTimeLocal). " +
    "IF YOU DON'T KNOW IT, don't guess and don't ask him to guess either — give a watch window " +
    "(watchFromLocal + watchUntilLocal) covering the likely hours, and Lucy books the moment " +
    "tables appear. A guessed minute doesn't error, it just loses.",
  inputSchema: z.object({
    venueId: z.number().int().positive().describe("From search_resy"),
    venueName: z.string().min(1).describe("Exactly as search_resy returned it"),
    reservationDate: z.string().describe("The night he wants to eat, YYYY-MM-DD"),
    partySize: z.number().int().min(1).max(20),
    earliestTime: z.string().describe("Earliest acceptable seating, 24h HH:MM (e.g. '19:00')"),
    latestTime: z.string().describe("Latest acceptable seating, 24h HH:MM (e.g. '21:00')"),
    preferredTime: z
      .string()
      .optional()
      .describe("Ideal seating time inside the window, 24h HH:MM — the ranking target"),
    slotTypes: z
      .array(z.string())
      .optional()
      .describe("Ranked table preferences, best first: ['Dining Room', 'Bar']. Omit for any."),
    maxDepositCents: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        "Hard cap on any deposit, in CENTS. Default 0 = refuse anything requiring a card. " +
          "'up to $50 deposit is fine' → 5000",
      ),
    dropAtLocal: z
      .string()
      .optional()
      .describe("Exact drop moment as owner-local wall clock, 'YYYY-MM-DDTHH:MM'. No offset."),
    daysAhead: z
      .number()
      .int()
      .min(1)
      .max(365)
      .optional()
      .describe("Alternative: books open this many days before the date ('30 days out' → 30)"),
    dropTimeLocal: z
      .string()
      .optional()
      .describe("Alternative: local time of day books open, HH:MM ('9am' → '09:00')"),
    watchFromLocal: z
      .string()
      .optional()
      .describe(
        "USE THIS WHEN THE DROP TIME ISN'T KNOWN. Start of a window to watch, owner-local " +
          "'YYYY-MM-DDTHH:MM'. Lucy polls across it and books the moment tables appear, " +
          "instead of firing at a guessed second. Requires watchUntilLocal.",
      ),
    watchUntilLocal: z
      .string()
      .optional()
      .describe("End of the watch window, owner-local 'YYYY-MM-DDTHH:MM'. Requires watchFromLocal."),
  }),
  approval: always(),
  async execute(input, ctx) {
    ensureResyStore();

    // 1. Shape checks first — all free, and a bad window is the failure mode
    //    that would otherwise sit armed and lose silently.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.reservationDate)) {
      return { ok: false as const, error: `reservationDate must be YYYY-MM-DD.` };
    }
    for (const [label, value] of [
      ["earliestTime", input.earliestTime],
      ["latestTime", input.latestTime],
      ["preferredTime", input.preferredTime],
    ] as const) {
      if (value && !TIME.test(value)) {
        return { ok: false as const, error: `${label} must be 24-hour HH:MM, got "${value}".` };
      }
    }
    if (input.earliestTime > input.latestTime) {
      return {
        ok: false as const,
        error: `The window is backwards — earliest ${input.earliestTime} is after latest ${input.latestTime}.`,
      };
    }
    if (
      input.preferredTime &&
      (input.preferredTime < input.earliestTime || input.preferredTime > input.latestTime)
    ) {
      return {
        ok: false as const,
        error: `preferredTime ${input.preferredTime} sits outside the ${input.earliestTime}–${input.latestTime} window.`,
      };
    }

    // 2. Resolve WHEN to act. Either an exact instant, or a window to watch.
    //
    // Watch mode exists because a venue's release time usually isn't knowable:
    // Resy publishes no booking-window metadata, and a snipe armed for the wrong
    // minute doesn't error — it polls an empty window and reports a clean miss.
    // Watching costs a few seconds of detection latency and cannot be an hour out.
    let dropAt: Date | null = null;
    let watchFrom: Date | null = null;
    let watchUntil: Date | null = null;

    if (input.watchFromLocal || input.watchUntilLocal) {
      if (!input.watchFromLocal || !input.watchUntilLocal) {
        return {
          ok: false as const,
          error: "A watch window needs BOTH watchFromLocal and watchUntilLocal.",
        };
      }
      if (input.dropAtLocal || input.daysAhead != null || input.dropTimeLocal) {
        return {
          ok: false as const,
          error:
            "Give either an exact drop time OR a watch window, not both — they're different " +
            "ways to decide when to act and I can't do both on one snipe.",
        };
      }
      watchFrom = computeDropAt(input.watchFromLocal);
      watchUntil = computeDropAt(input.watchUntilLocal);
      if (!watchFrom || !watchUntil) {
        return {
          ok: false as const,
          error: "Couldn't read the watch window. Use YYYY-MM-DDTHH:MM with no offset.",
        };
      }
      if (watchFrom >= watchUntil) {
        return { ok: false as const, error: "The watch window ends before it starts." };
      }
      if (watchUntil.getTime() <= Date.now()) {
        return { ok: false as const, error: "That watch window has already passed." };
      }
    } else if (input.dropAtLocal) {
      dropAt = computeDropAt(input.dropAtLocal);
      if (!dropAt) {
        return {
          ok: false as const,
          error: `Couldn't read "${input.dropAtLocal}" as a local time. Use YYYY-MM-DDTHH:MM with no offset.`,
        };
      }
    } else if (input.daysAhead != null && input.dropTimeLocal) {
      if (!TIME.test(input.dropTimeLocal)) {
        return { ok: false as const, error: `dropTimeLocal must be HH:MM, got "${input.dropTimeLocal}".` };
      }
      dropAt = dropAtForBookingWindow(input.reservationDate, input.daysAhead, input.dropTimeLocal);
      if (!dropAt) return { ok: false as const, error: "Couldn't work out the drop time from those dates." };
    } else {
      return {
        ok: false as const,
        error:
          "I need to know when to act: either an exact drop time (dropAtLocal, or daysAhead " +
          "plus dropTimeLocal), or a window to watch (watchFromLocal + watchUntilLocal). " +
          "If the owner doesn't know when the restaurant releases tables, DON'T guess — use a " +
          "watch window covering the likely hours. A guessed minute loses silently.",
      };
    }

    if (dropAt && dropAt.getTime() <= Date.now()) {
      return {
        ok: false as const,
        error:
          `That drop time (${formatLocal(dropAt.toISOString())}) has already passed. If tables ` +
          `are already out, check resy_availability and book directly instead of sniping.`,
      };
    }

    // 3. Cap check before anything on the network.
    const { count, error: countError } = await supabase
      .from("resy_snipes")
      .select("id", { count: "exact", head: true })
      .in("status", ["armed", "firing"]);
    if (countError) return { ok: false as const, error: countError.message };
    if ((count ?? 0) >= MAX_ACTIVE_SNIPES) {
      return {
        ok: false as const,
        error:
          `There are already ${count} snipes armed, which is the maximum (${MAX_ACTIVE_SNIPES}). ` +
          `Call list_resy_snipes, show the owner what's queued, ask which to drop, cancel it ` +
          `with cancel_resy_snipe, then try again. Do NOT retry without cancelling one first.`,
      };
    }

    // 4. Verify the venue can actually be booked headlessly. This is the check
    //    that stops the worst outcome in the whole feature: an armed snipe that
    //    was never going to work, on a night the owner has stopped looking for
    //    a table because he believes it's handled.
    let venue;
    try {
      venue = await venueLookup(input.venueId, input.venueName);
    } catch (err) {
      const message = err instanceof ResyError ? err.message : redact(String(err));
      return { ok: false as const, error: message };
    }
    if (!venue) {
      return {
        ok: false as const,
        error:
          `Couldn't re-find venue ${input.venueId} ("${input.venueName}") on Resy. Run search_resy ` +
          `again and use the id and name exactly as it returns them.`,
      };
    }

    const blocker = snipeBlocker(venue, input.partySize);
    if (blocker) {
      return {
        ok: false as const,
        error:
          `${blocker} Don't arm this — tell the owner plainly why an automatic booking won't ` +
          `work there, and offer to check availability manually instead.`,
      };
    }

    // 5. Delivery target from the VERIFIED session, never from the model.
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

    const maxDepositCents = input.maxDepositCents ?? 0;

    const { data, error } = await supabase
      .from("resy_snipes")
      .insert({
        channel,
        phone,
        slack_target: slackTarget,
        venue_id: venue.id,
        venue_name: venue.name,
        venue_slug: venue.slug,
        reservation_date: input.reservationDate,
        party_size: input.partySize,
        earliest_time: input.earliestTime,
        latest_time: input.latestTime,
        preferred_time: input.preferredTime ?? null,
        slot_types: input.slotTypes?.length ? input.slotTypes : null,
        max_deposit_cents: maxDepositCents,
        drop_at: dropAt ? dropAt.toISOString() : null,
        watch_from: watchFrom ? watchFrom.toISOString() : null,
        watch_until: watchUntil ? watchUntil.toISOString() : null,
      })
      .select("id")
      .single();

    if (error) {
      if (error.code === "23505") {
        return {
          ok: false as const,
          error:
            `There's already a snipe armed for ${venue.name} on ${input.reservationDate} for ` +
            `${input.partySize}. Tell the owner it's already covered — list_resy_snipes if he ` +
            `wants to see it, and cancel it first if he wants different bounds.`,
        };
      }
      return { ok: false as const, error: error.message };
    }

    return {
      ok: true as const,
      id: data.id as string,
      venue: venue.name,
      date: input.reservationDate,
      partySize: input.partySize,
      window: `${formatTime(input.earliestTime)}–${formatTime(input.latestTime)}`,
      preferred: input.preferredTime ? formatTime(input.preferredTime) : null,
      tablePreference: input.slotTypes?.length ? input.slotTypes : "any",
      maxDeposit: maxDepositCents === 0 ? "none — I'll skip anything needing a card" : formatUsd(maxDepositCents),
      // Echo the RESOLVED instant back in owner-local terms. The owner is about
      // to approve this card; a drop time computed an hour off is only catchable
      // here, by him, before it's armed.
      dropsAt: dropAt ? formatLocal(dropAt.toISOString()) : null,
      watching:
        watchFrom && watchUntil
          ? `${formatLocal(watchFrom.toISOString())} until ${formatLocal(watchUntil.toISOString())}`
          : null,
      armedSnipes: (count ?? 0) + 1,
      maxSnipes: MAX_ACTIVE_SNIPES,
    };
  },
});
