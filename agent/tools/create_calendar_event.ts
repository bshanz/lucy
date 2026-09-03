import { defineTool } from "eve/tools";
import { z } from "zod";
import { insertEvent, normalizeAttendees } from "#lib/calendar.js";
import { formatLocal, ownerTimezone, ownerWallClockToUtc, primeOwnerTimezone } from "#lib/reminders.js";

export default defineTool({
  description:
    "Create an event on the owner's Google Calendar. Times are owner-local wall-clock (no offsets) — " +
    "the tool handles the timezone. Pass `attendees` to invite people: Google emails them a " +
    "real invitation, so that path REQUIRES the owner's approval and he sees the guest list " +
    "first. Confirm the returned localTime back to the owner.",
  inputSchema: z.object({
    title: z.string().min(1),
    startLocal: z.string().min(1).describe("Start, owner-local YYYY-MM-DDTHH:mm"),
    endLocal: z
      .string()
      .optional()
      .describe("End, owner-local YYYY-MM-DDTHH:mm; defaults to one hour after start"),
    description: z.string().optional(),
    location: z.string().optional(),
    attendees: z
      .array(z.string().email())
      .max(20)
      .optional()
      .describe(
        "Guests to invite, as real email addresses you have actually resolved — never " +
          "guess one from a name. Omit for a personal event. The owner's own address is " +
          "dropped automatically; he's the organizer.",
      ),
  }),
  // Solo events stay frictionless; the moment the call would land in somebody
  // else's inbox the owner sees an approval card with the guest list on it.
  approval: ({ toolInput }) =>
    (toolInput?.attendees?.length ?? 0) > 0 ? "user-approval" : "not-applicable",
  async execute({ title, startLocal, endLocal, description, location, attendees }) {
    // Tools run in their own workflow step, not in the invocation that primed
    // the zone at ingress, so the cache is cold here. See primeOwnerTimezone.
    await primeOwnerTimezone();
    const start = ownerWallClockToUtc(startLocal);
    if (!start) return { ok: false as const, error: "startLocal must be YYYY-MM-DDTHH:mm" };
    const end = endLocal
      ? ownerWallClockToUtc(endLocal)
      : new Date(start.getTime() + 3600 * 1000);
    if (!end) return { ok: false as const, error: "endLocal must be YYYY-MM-DDTHH:mm" };

    const guests = normalizeAttendees(attendees);
    const created = await insertEvent(
      {
        summary: title,
        description,
        location,
        start: { dateTime: start.toISOString(), timeZone: ownerTimezone() },
        end: { dateTime: end.toISOString(), timeZone: ownerTimezone() },
        ...(guests.length ? { attendees: guests.map((email) => ({ email })) } : {}),
      },
      guests.length > 0,
    );

    return {
      ok: true as const,
      id: created.id,
      localTime: formatLocal(start.toISOString()),
      link: created.htmlLink,
      invited: guests,
    };
  },
});
