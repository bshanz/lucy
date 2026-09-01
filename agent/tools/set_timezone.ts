import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  clearTravelOverride,
  formatLocal,
  homeTimezone,
  isValidTimezone,
  nowInOwnerTz,
  ownerTimezone,
  primeOwnerTimezone,
  reanchorRecurring,
  wallClockToUtc,
  writeTravelOverride,
} from "#lib/reminders.js";

/**
 * How far out a return date may sit. A trip is a trip; a "2027" typo that
 * silently parks him in Pacific for a year is the failure this prevents.
 */
const MAX_TRIP_DAYS = 180;

export default defineTool({
  description:
    "Temporarily move the owner's timezone while he travels, so reminders, the nightly check-in " +
    "and quiet hours follow him. Pass an IANA zone plus the last day he's away; it reverts to his " +
    "home zone on its own after that. Pass timezone 'home' to switch back early. Always know the " +
    "return date before calling — ask him how long he's there rather than guessing. Repeating " +
    "reminders move with him (a 7:45pm check-in stays 7:45pm); one-off reminders keep the exact " +
    "times they were set for. Confirm the returned zone and until date back to him.",
  inputSchema: z.object({
    timezone: z
      .string()
      .min(1)
      .describe(
        "Full IANA Area/Location zone he is traveling to, e.g. 'America/Los_Angeles', " +
          "'Europe/London', 'Asia/Tokyo'. Never an abbreviation ('PST', 'EST') — they are " +
          "refused. Pass the literal 'home' to revert to his home zone now.",
      ),
    untilLocal: z
      .string()
      .optional()
      .describe(
        "His last day away, YYYY-MM-DD, as a date in the destination zone. Required unless " +
          "timezone is 'home'. The switch lapses at the end of this day.",
      ),
  }),
  async execute(input) {
    // Whatever zone is in force right now is the one existing recurring rows
    // are anchored to, so it is the "from" side of every re-anchor below.
    const from = await primeOwnerTimezone();
    const home = homeTimezone();

    if (input.timezone.trim().toLowerCase() === "home") {
      if (from === home) {
        return { ok: true as const, timezone: home, homeTimezone: home, until: null, reanchored: 0, alreadyHome: true };
      }
      await clearTravelOverride();
      const reanchored = await reanchorRecurring(from, home);
      return { ok: true as const, timezone: home, homeTimezone: home, until: null, reanchored, alreadyHome: false };
    }

    const tz = input.timezone.trim();
    if (!isValidTimezone(tz)) {
      return {
        ok: false as const,
        error:
          `'${tz}' is not usable. Give a full IANA Area/Location name like ` +
          "'America/Los_Angeles' or 'Europe/Paris'. Abbreviations are refused on purpose: " +
          "'EST' resolves to America/Panama and 'MST' to America/Phoenix, neither of which " +
          "observes daylight saving, so they would put him an hour off for half the year.",
      };
    }

    if (!input.untilLocal) {
      return {
        ok: false as const,
        error:
          "untilLocal is required: the switch has to know when to end, or he stays on the wrong " +
          "zone for weeks after he gets home. Ask him what day he's back and retry.",
      };
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.untilLocal.trim())) {
      return { ok: false as const, error: "untilLocal must be a date, YYYY-MM-DD, e.g. 2026-09-06" };
    }

    // End of his last day away, resolved in the DESTINATION zone — the override
    // should cover the whole of that day where he actually is.
    const until = wallClockToUtc(`${input.untilLocal.trim()}T23:59`, tz);
    if (!until) {
      return { ok: false as const, error: "untilLocal must be a date, YYYY-MM-DD, e.g. 2026-09-06" };
    }
    if (until.getTime() <= Date.now()) {
      return {
        ok: false as const,
        error: `That return date has already passed. It is currently ${nowInOwnerTz()} — recompute it and retry.`,
      };
    }
    const days = (until.getTime() - Date.now()) / 86_400_000;
    if (days > MAX_TRIP_DAYS) {
      return {
        ok: false as const,
        error:
          `That's ${Math.round(days)} days away — longer than a trip, and probably a typo in the ` +
          `year. Confirm the date with him. If he has genuinely moved, his home zone (OWNER_TIMEZONE) ` +
          "should change instead.",
      };
    }

    await writeTravelOverride({ timezone: tz, until: until.toISOString(), setAt: new Date().toISOString() });
    // Re-anchor AFTER the write so formatLocal in the response renders in the
    // zone he is actually moving to.
    const reanchored = await reanchorRecurring(from, tz);

    return {
      ok: true as const,
      timezone: ownerTimezone(),
      homeTimezone: home,
      until: formatLocal(until.toISOString()),
      reanchored,
      alreadyHome: false,
    };
  },
});
