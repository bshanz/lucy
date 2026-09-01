import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  type GcalAttendee,
  getEvent,
  hasGuests,
  mergeAttendees,
  normalizeAttendees,
  patchEvent,
  shiftedEnd,
} from "#lib/calendar.js";
import { formatLocal, ownerTimezone, ownerWallClockToUtc } from "#lib/reminders.js";

export default defineTool({
  description:
    "Change an existing event on the owner's Google Calendar — retitle it, move it, or add " +
    "and remove guests. Get the eventId from list_calendar_events. Times are owner-local wall-clock " +
    "(no offsets). Anything that touches an event with guests emails all of them, so those " +
    "calls REQUIRE the owner's approval.",
  inputSchema: z.object({
    eventId: z.string().min(1).describe("Event id from list_calendar_events"),
    title: z.string().min(1).optional(),
    startLocal: z
      .string()
      .optional()
      .describe("New start, owner-local YYYY-MM-DDTHH:mm; the duration is kept if no end"),
    endLocal: z.string().optional().describe("New end, owner-local YYYY-MM-DDTHH:mm"),
    description: z.string().optional(),
    location: z.string().optional(),
    addAttendees: z
      .array(z.string().email())
      .max(20)
      .optional()
      .describe("Guests to invite, as real email addresses you have actually resolved"),
    removeAttendees: z
      .array(z.string().email())
      .max(20)
      .optional()
      .describe("Guests to uninvite; Google tells them the event was cancelled for them"),
  }),
  // Adding or removing a guest obviously mails someone. So does moving an event
  // that already has guests on it — which the input alone can't tell us, hence
  // the lookup. If that lookup fails we ask rather than assume it's private.
  approval: async ({ toolInput }) => {
    if (toolInput?.addAttendees?.length || toolInput?.removeAttendees?.length) {
      return "user-approval";
    }
    if (!toolInput?.eventId) return "user-approval";
    try {
      return hasGuests(await getEvent(toolInput.eventId)) ? "user-approval" : "not-applicable";
    } catch {
      return "user-approval";
    }
  },
  async execute(input) {
    const {
      eventId,
      title,
      startLocal,
      endLocal,
      description,
      location,
      addAttendees,
      removeAttendees,
    } = input;

    const changesGuests = Boolean(addAttendees?.length || removeAttendees?.length);
    const touchesSomething =
      changesGuests ||
      [title, startLocal, endLocal, description, location].some((v) => v !== undefined);
    if (!touchesSomething) {
      return {
        ok: false as const,
        error: "Nothing to change — pass a new title, time, description, location, or guests.",
      };
    }

    const existing = await getEvent(eventId);
    const patch: Record<string, unknown> = {};
    if (title !== undefined) patch.summary = title;
    if (description !== undefined) patch.description = description;
    if (location !== undefined) patch.location = location;

    let start: Date | null = null;
    if (startLocal !== undefined) {
      start = ownerWallClockToUtc(startLocal);
      if (!start) return { ok: false as const, error: "startLocal must be YYYY-MM-DDTHH:mm" };
      patch.start = { dateTime: start.toISOString(), timeZone: ownerTimezone() };
    }

    if (endLocal !== undefined) {
      const end = ownerWallClockToUtc(endLocal);
      if (!end) return { ok: false as const, error: "endLocal must be YYYY-MM-DDTHH:mm" };
      patch.end = { dateTime: end.toISOString(), timeZone: ownerTimezone() };
    } else if (start) {
      const end = shiftedEnd(existing.start?.dateTime, existing.end?.dateTime, start);
      if (!end) {
        return {
          ok: false as const,
          error: "Can't infer how long this event runs — pass endLocal too.",
        };
      }
      patch.end = { dateTime: end.toISOString(), timeZone: ownerTimezone() };
    }

    let guests: GcalAttendee[] | undefined;
    if (changesGuests) {
      guests = mergeAttendees(existing.attendees, addAttendees, removeAttendees);
      patch.attendees = guests;
    }

    // Notify when the event has guests either before or after this change —
    // people being removed need the mail as much as people being added.
    const notify = hasGuests(existing) || (guests ? hasGuests({ attendees: guests }) : false);
    const updated = await patchEvent(eventId, patch, notify);
    const finalGuests = normalizeAttendees(
      (updated.attendees ?? []).map((a) => a.email).filter((e): e is string => Boolean(e)),
    );

    return {
      ok: true as const,
      id: updated.id,
      title: updated.summary ?? "(no title)",
      localTime: updated.start?.dateTime
        ? formatLocal(updated.start.dateTime)
        : updated.start?.date ?? "",
      link: updated.htmlLink,
      attendees: finalGuests,
      notified: notify,
    };
  },
});
