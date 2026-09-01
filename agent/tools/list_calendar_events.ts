import { defineTool } from "eve/tools";
import { z } from "zod";
import type { GcalEvent } from "#lib/calendar.js";
import { googleApiFetch } from "#lib/gmail.js";
import { formatLocal, ownerTimezone, ownerWallClockToUtc } from "#lib/reminders.js";

export default defineTool({
  description:
    "List events on the owner's Google Calendar in an owner-local time window. Defaults to " +
    "the next 7 days. Times in and out are owner-local wall-clock (no offsets). Each event carries its " +
    "id (pass it to update_calendar_event) and its guests with their RSVP status.",
  inputSchema: z.object({
    fromLocal: z
      .string()
      .optional()
      .describe("Window start, owner-local YYYY-MM-DDTHH:mm; defaults to now"),
    toLocal: z
      .string()
      .optional()
      .describe("Window end, owner-local YYYY-MM-DDTHH:mm; defaults to 7 days out"),
    maxResults: z.number().int().min(1).max(50).optional().describe("Default 15"),
  }),
  async execute({ fromLocal, toLocal, maxResults }) {
    const timeMin = fromLocal ? ownerWallClockToUtc(fromLocal) : new Date();
    const timeMax = toLocal
      ? ownerWallClockToUtc(toLocal)
      : new Date(Date.now() + 7 * 24 * 3600 * 1000);
    if (!timeMin || !timeMax) {
      return { ok: false as const, error: "Times must be owner-local YYYY-MM-DDTHH:mm" };
    }

    const params = new URLSearchParams({
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: String(maxResults ?? 15),
    });
    const data = await googleApiFetch<{ items?: GcalEvent[] }>(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
    );

    return {
      ok: true as const,
      events: (data.items ?? []).map((e) => ({
        id: e.id,
        title: e.summary ?? "(no title)",
        start: e.start?.dateTime ? formatLocal(e.start.dateTime) : e.start?.date ?? "",
        end: e.end?.dateTime ? formatLocal(e.end.dateTime) : e.end?.date ?? "",
        allDay: !e.start?.dateTime,
        location: e.location,
        meetLink: e.hangoutLink,
        attendees: e.attendees
          ?.filter((a) => a.email)
          .map((a) => ({ email: a.email, status: a.responseStatus })),
      })),
    };
  },
});
