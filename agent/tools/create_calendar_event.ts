import { defineTool } from "eve/tools";
import { z } from "zod";
import { googleApiFetch } from "#lib/gmail.js";
import { formatLocal, ownerTimezone, ownerWallClockToUtc } from "#lib/reminders.js";

export default defineTool({
  description:
    "Create an event on the owner's Google Calendar. Times are NY wall-clock (no offsets) — " +
    "the tool handles the timezone. Personal events only (no attendees/invites in v1). " +
    "Confirm the returned localTime back to the owner.",
  inputSchema: z.object({
    title: z.string().min(1),
    startLocal: z.string().min(1).describe("Start, NY local time YYYY-MM-DDTHH:mm"),
    endLocal: z
      .string()
      .optional()
      .describe("End, NY local time YYYY-MM-DDTHH:mm; defaults to one hour after start"),
    description: z.string().optional(),
    location: z.string().optional(),
  }),
  async execute({ title, startLocal, endLocal, description, location }) {
    const start = ownerWallClockToUtc(startLocal);
    if (!start) return { ok: false as const, error: "startLocal must be YYYY-MM-DDTHH:mm" };
    const end = endLocal
      ? ownerWallClockToUtc(endLocal)
      : new Date(start.getTime() + 3600 * 1000);
    if (!end) return { ok: false as const, error: "endLocal must be YYYY-MM-DDTHH:mm" };

    const created = await googleApiFetch<{ id: string; htmlLink?: string }>(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events",
      {
        method: "POST",
        body: JSON.stringify({
          summary: title,
          description,
          location,
          start: { dateTime: start.toISOString(), timeZone: ownerTimezone() },
          end: { dateTime: end.toISOString(), timeZone: ownerTimezone() },
        }),
      },
    );

    return {
      ok: true as const,
      id: created.id,
      localTime: formatLocal(start.toISOString()),
      link: created.htmlLink,
    };
  },
});
