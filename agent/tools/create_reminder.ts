import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  formatLocal,
  nowInOwnerTz,
  ownerWallClockToUtc,
  parseRecurrence,
  primeOwnerTimezone,
  supabase,
  type ReminderChannel,
} from "#lib/reminders.js";
import { EACH_TIME, describeTrigger, getPlace, normalizePlace } from "#lib/location.js";

export default defineTool({
  description:
    "Schedule a reminder for the owner. fireAtLocal is his current local wall-clock time with NO " +
    "timezone offset — the tool handles the zone and DST itself. The zone is the one named in the " +
    "time line on every message, which follows him while he travels. When the owner says '5pm', " +
    "pass 17:00 on the right date; never convert to UTC yourself. The reminder fires on the " +
    "channel the request came from unless asked otherwise. Confirm the returned localTime back " +
    "to the owner.\n\nLOCATION reminders ('when I get home', 'when I leave work'): pass place + on " +
    "INSTEAD of fireAtLocal — never guess a time for these. It fires when his phone reports the " +
    "arrival/departure. recurrence 'each_time' makes it fire on every arrival. If the result has " +
    "needsSetup, his phone has never reported that place: load the location skill and walk him " +
    "through adding the automation.",
  inputSchema: z.object({
    body: z.string().min(1).describe("What to remind the owner about, in plain words"),
    fireAtLocal: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Owner-local time, YYYY-MM-DDTHH:mm (24h), e.g. 2026-07-30T17:00. Omit for a location reminder.",
      ),
    place: z
      .string()
      .min(1)
      .optional()
      .describe("Location reminder: the place name, e.g. 'home', 'work', 'gym'. Use with `on`."),
    on: z
      .enum(["arrive", "leave"])
      .optional()
      .describe("Location reminder: fire when he arrives at or leaves `place`"),
    recurrence: z
      .string()
      .optional()
      .describe(
        "Repeat cadence; omit for a one-off reminder. One of: 'daily', 'weekly', " +
          "'weekdays' (Mon-Fri only), 'monthly' (same day each month, clamped to month " +
          "length), or 'every_N_days' (e.g. 'every_3_days'). Location reminders accept only " +
          "'each_time' (fire on every arrival/departure).",
      ),
    channel: z
      .enum(["imessage", "slack"])
      .optional()
      .describe("Where the reminder should fire; defaults to the current channel"),
  }),
  async execute(input, ctx) {
    // Tools run in their own workflow step, not in the invocation that primed
    // the zone at ingress, so the cache is cold here. See primeOwnerTimezone.
    await primeOwnerTimezone();

    const isPlace = input.place !== undefined || input.on !== undefined;
    if (isPlace && input.fireAtLocal) {
      return {
        ok: false as const,
        error: "Pass either fireAtLocal (a time) or place + on (a location), not both.",
      };
    }
    if (isPlace) return createPlaceReminder(input, ctx);
    if (!input.fireAtLocal) {
      return {
        ok: false as const,
        error: "Pass fireAtLocal for a timed reminder, or place + on for a location reminder.",
      };
    }

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

    const target = resolveTarget(input.channel, ctx);
    if (!target.ok) return target;
    const { channel, phone, slackTarget } = target;

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

type Input = {
  body: string;
  place?: string;
  on?: "arrive" | "leave";
  recurrence?: string;
  channel?: ReminderChannel;
};
type Ctx = { session: { auth: { current?: { attributes?: unknown } | null } } };

/** Where a reminder fires: the channel it was asked from, unless told otherwise. */
function resolveTarget(requested: ReminderChannel | undefined, ctx: Ctx) {
  const attrs = ctx.session.auth.current?.attributes as
    | { channel?: string; phone?: string; slackChannelId?: string }
    | undefined;
  const channel: ReminderChannel = requested ?? (attrs?.channel === "slack" ? "slack" : "imessage");

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
  return { ok: true as const, channel, phone, slackTarget };
}

/**
 * A reminder anchored to a place: fire_at stays NULL until his phone reports
 * the arrival/departure (POST /location/event), which stamps it due.
 */
async function createPlaceReminder(input: Input, ctx: Ctx) {
  if (!input.place || !input.on) {
    return { ok: false as const, error: "A location reminder needs both place and on (arrive|leave)." };
  }
  const place = normalizePlace(input.place);
  if (!place) return { ok: false as const, error: "place is empty after normalizing" };
  if (input.recurrence && input.recurrence !== EACH_TIME) {
    return {
      ok: false as const,
      error: `Location reminders repeat only as '${EACH_TIME}' (every arrival/departure), or omit recurrence.`,
    };
  }

  const target = resolveTarget(input.channel, ctx);
  if (!target.ok) return target;

  const known = await getPlace(place).catch(() => null);

  const { data, error } = await supabase
    .from("reminders")
    .insert({
      channel: target.channel,
      phone: target.phone,
      slack_target: target.slackTarget,
      body: input.body,
      fire_at: null,
      recurrence: input.recurrence ?? null,
      trigger_place: place,
      trigger_event: input.on,
    })
    .select("id")
    .single();
  if (error) return { ok: false as const, error: error.message };

  return {
    ok: true as const,
    id: data.id as string,
    fires: describeTrigger(place, input.on, "you"),
    place,
    recurrence: input.recurrence ?? null,
    channel: target.channel,
    // His phone has never pinged this place, so nothing will ever fire it until
    // he adds the Shortcuts automation. Saying "got it" without that would be
    // a reminder that silently never arrives.
    ...(known
      ? {}
      : {
          needsSetup: true as const,
          setupNote:
            `No automation has ever reported "${place}". The reminder is saved, but it will only ` +
            `fire once he adds an iPhone Shortcuts automation for ${input.on === "arrive" ? "arriving at" : "leaving"} ` +
            `${place.replace(/_/g, " ")} (location skill has the steps).`,
        }),
  };
}
