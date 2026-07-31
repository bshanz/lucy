import { defineTool } from "eve/tools";
import { z } from "zod";
import { googleApiFetch } from "#lib/gmail.js";
import { formatLocal, ownerTimezone, ownerWallClockToUtc } from "#lib/reminders.js";

interface GcalEvent {
  id: string;
  summary?: string;
  location?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: Array<{ email?: string; responseStatus?: string }>;
  hangoutLink?: string;
}

export default defineTool({
  description:
    "List events on the owner's Google Calendar in a New York local-time window. Defaults to " +
    "the next 7 days. Times in and out are NY wall-clock (no offsets).",
  inputSchema: z.object({
    fromLocal: z
      .string()
      .optional()
      .describe("Window start, NY local time YYYY-MM-DDTHH:mm; defaults to now"),
    toLocal: z
      .string()
      .optional()
      .describe("Window end, NY local time YYYY-MM-DDTHH:mm; defaults to 7 days out"),
    maxResults: z.number().int().min(1).max(50).optional().describe("Default 15"),
  }),
  async execute({ fromLocal, toLocal, maxResults }) {
    const timeMin = fromLocal ? ownerWallClockToUtc(fromLocal) : new Date();
    const timeMax = toLocal
      ? ownerWallClockToUtc(toLocal)
      : new Date(Date.now() + 7 * 24 * 3600 * 1000);
    if (!timeMin || !timeMax) {
      return { ok: false as const, error: "Times must be NY local YYYY-MM-DDTHH:mm" };
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
      })),
    };
  },
});
