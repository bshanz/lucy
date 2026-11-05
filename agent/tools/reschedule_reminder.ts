import { defineTool } from "eve/tools";
import { z } from "zod";
import { EACH_TIME } from "#lib/location.js";
import { formatLocal, ownerWallClockToUtc, primeOwnerTimezone, supabase } from "#lib/reminders.js";

export default defineTool({
  description:
    "Move a reminder to a new time — works for upcoming reminders AND fired-but-unconfirmed " +
    "ones (e.g. the owner says 'push it to Friday' after a follow-up) — including ones that " +
    "already ran out of nudges. Owner-local wall-clock time, no offset. Resets the follow-up cycle, " +
    "so the full run of nudges starts over from the new fire time. On a location reminder ('when " +
    "I get home') this turns it into a plain timed one.",
  inputSchema: z.object({
    id: z.string().uuid().describe("The reminder id to reschedule"),
    fireAtLocal: z
      .string()
      .min(1)
      .describe("New fire time, owner-local YYYY-MM-DDTHH:mm, e.g. 2026-08-01T17:00"),
  }),
  async execute({ id, fireAtLocal }) {
    // Tools run in their own workflow step, not in the invocation that primed
    // the zone at ingress, so the cache is cold here. See primeOwnerTimezone.
    await primeOwnerTimezone();
    const fireAt = ownerWallClockToUtc(fireAtLocal);
    if (!fireAt) {
      return { ok: false as const, error: "fireAtLocal must be YYYY-MM-DDTHH:mm owner-local time" };
    }
    if (fireAt.getTime() < Date.now() - 60_000) {
      return { ok: false as const, error: "That time is in the past — re-check the date" };
    }

    const { data: existing } = await supabase
      .from("reminders")
      .select("recurrence")
      .eq("id", id)
      .maybeSingle();

    const { data, error } = await supabase
      .from("reminders")
      .update({
        ...(existing?.recurrence === EACH_TIME ? { recurrence: null } : {}),
        fire_at: fireAt.toISOString(),
        status: "pending",
        follow_up_count: 0,
        next_follow_up_at: null,
        sent_at: null,
        // A time now anchors it, so any location trigger is dropped — and each_time
        // (cleared above) is not a cadence nextOccurrence can step.
        trigger_place: null,
        trigger_event: null,
      })
      .eq("id", id)
      .in("status", ["pending", "awaiting_delivery", "sent", "sending", "lapsed"])
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
