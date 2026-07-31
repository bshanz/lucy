import { defineTool } from "eve/tools";
import { z } from "zod";
import { formatLocal, ownerWallClockToUtc, supabase } from "#lib/reminders.js";

export default defineTool({
  description:
    "Move a reminder to a new time — works for upcoming reminders AND fired-but-unconfirmed " +
    "ones (e.g. the owner says 'push it to Friday' after a follow-up). New York wall-clock time, " +
    "no offset. Resets the follow-up cycle so he'll get nudged again 24h after the new fire.",
  inputSchema: z.object({
    id: z.string().uuid().describe("The reminder id to reschedule"),
    fireAtLocal: z
      .string()
      .min(1)
      .describe("New fire time, NY local YYYY-MM-DDTHH:mm, e.g. 2026-08-01T17:00"),
  }),
  async execute({ id, fireAtLocal }) {
    const fireAt = ownerWallClockToUtc(fireAtLocal);
    if (!fireAt) {
      return { ok: false as const, error: "fireAtLocal must be YYYY-MM-DDTHH:mm NY local time" };
    }
    if (fireAt.getTime() < Date.now() - 60_000) {
      return { ok: false as const, error: "That time is in the past — re-check the date" };
    }

    const { data, error } = await supabase
      .from("reminders")
      .update({
        fire_at: fireAt.toISOString(),
        status: "pending",
        followed_up: false,
        sent_at: null,
      })
      .eq("id", id)
      .in("status", ["pending", "sent", "sending"])
      .select("id, body, fire_at")
      .maybeSingle();
    if (error) return { ok: false as const, error: error.message };
    if (!data) return { ok: false as const, error: "No active reminder with that id" };

    return {
      ok: true as const,
      body: data.body as string,
      localTime: formatLocal(data.fire_at as string),
    };
  },
});
