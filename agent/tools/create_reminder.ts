import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  formatLocal,
  nowInOwnerTz,
  ownerWallClockToUtc,
  parseRecurrence,
  supabase,
  type ReminderChannel,
} from "#lib/reminders.js";

export default defineTool({
  description:
    "Schedule a reminder for the owner. fireAtLocal is his current local wall-clock time with NO " +
    "timezone offset — the tool handles the zone and DST itself. The zone is the one named in the " +
    "time line on every message, which follows him while he travels. When the owner says '5pm', " +
    "pass 17:00 on the right date; never convert to UTC yourself. The reminder fires on the " +
    "channel the request came from unless asked otherwise. Confirm the returned localTime back " +
    "to the owner.",
  inputSchema: z.object({
    body: z.string().min(1).describe("What to remind the owner about, in plain words"),
    fireAtLocal: z
      .string()
      .min(1)
      .describe("Owner-local time, YYYY-MM-DDTHH:mm (24h), e.g. 2026-07-30T17:00"),
    recurrence: z
      .string()
      .optional()
      .describe(
        "Repeat cadence; omit for a one-off reminder. One of: 'daily', 'weekly', " +
          "'weekdays' (Mon-Fri only), 'monthly' (same day each month, clamped to month " +
          "length), or 'every_N_days' (e.g. 'every_3_days')",
      ),
    channel: z
      .enum(["imessage", "slack"])
      .optional()
      .describe("Where the reminder should fire; defaults to the current channel"),
  }),
  async execute(input, ctx) {
    const fireAt = ownerWallClockToUtc(input.fireAtLocal);
    if (!fireAt) {
      return {
        ok: false as const,
        error: "fireAtLocal must be YYYY-MM-DDTHH:mm owner-local time, e.g. 2026-07-30T17:00",
      };
    }
    if (fireAt.getTime() < Date.now() - 60_000) {
      return {
        ok: false as const,
        error: `That time is in the past. It is currently ${nowInOwnerTz()} — recompute the date from that and retry.`,
      };
    }

    const recurrence = input.recurrence ? parseRecurrence(input.recurrence) : null;
    if (input.recurrence && !recurrence) {
      return {
        ok: false as const,
        error: "Invalid recurrence — use daily, weekly, weekdays, monthly, or every_N_days",
      };
    }

    const attrs = ctx.session.auth.current?.attributes as
      | { channel?: string; phone?: string; slackChannelId?: string }
      | undefined;
    const channel: ReminderChannel =
      input.channel ?? (attrs?.channel === "slack" ? "slack" : "imessage");

    const phone = channel === "imessage" ? attrs?.phone ?? process.env.OWNER_PHONE ?? null : null;
    const slackTarget =
      channel === "slack" && attrs?.slackChannelId ? { channelId: attrs.slackChannelId } : null;

    if (channel === "imessage" && !phone) {
      return { ok: false as const, error: "No phone number configured (OWNER_PHONE missing)" };
    }
    if (channel === "slack" && !slackTarget) {
      return {
        ok: false as const,
        error: "Can't target Slack from here — ask the owner to request it from a Slack DM, or use imessage",
      };
    }

    const { data, error } = await supabase
      .from("reminders")
      .insert({
        channel,
        phone,
        slack_target: slackTarget,
        body: input.body,
        fire_at: fireAt.toISOString(),
        recurrence,
      })
      .select("id, fire_at")
      .single();
    if (error) return { ok: false as const, error: error.message };

    return {
      ok: true as const,
      id: data.id as string,
      localTime: formatLocal(data.fire_at as string),
      recurrence,
      channel,
    };
  },
});
