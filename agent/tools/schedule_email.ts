import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { formatLocal, nowInOwnerTz, ownerWallClockToUtc, primeOwnerTimezone } from "#lib/reminders.js";
import { MAX_SCHEDULED, MIN_LEAD_MS, supabase } from "#lib/scheduled-email.js";

export default defineTool({
  description:
    "Send an email at a FUTURE time from the owner's Gmail. REQUIRES the owner's explicit " +
    "approval — he sees the recipient, subject, full body and send time on a card first, and " +
    "THAT CARD IS THE AUTHORIZATION: at the scheduled minute the email goes out EXACTLY as " +
    "written here, unattended, and he is NOT asked again. So write the FINAL body — no " +
    "placeholders, nothing you plan to fill in later, nothing you'd want to revise at send " +
    "time, because you will not get the chance. The card shows sendAtLocal as you typed it, " +
    "so say the date and time back to him in plain words when you ask. " +
    "For an email he wants gone now, use send_email instead; to reply on an existing thread " +
    "use reply_to_email (which cannot be scheduled). " +
    "sendAtLocal is the owner's local wall clock with NO timezone offset — when he says '9am " +
    "tomorrow', pass tomorrow's date and 09:00; never convert to UTC yourself.",
  inputSchema: z.object({
    to: z.string().email().describe("Recipient address"),
    subject: z.string().min(1),
    body: z
      .string()
      .min(1)
      .describe(
        "The complete email body, exactly as it should arrive; light markdown (bold, links, " +
          "inline code) is rendered. This text is stored and sent verbatim.",
      ),
    sendAtLocal: z
      .string()
      .min(1)
      .describe("Owner-local send time, YYYY-MM-DDTHH:mm (24h), e.g. 2026-08-14T09:00"),
  }),
  approval: always(),
  async execute(input, ctx) {
    // Tools run in their own workflow step, not in the invocation that primed
    // the zone at ingress, so the cache is cold here. See primeOwnerTimezone.
    await primeOwnerTimezone();
    const sendAt = ownerWallClockToUtc(input.sendAtLocal);
    if (!sendAt) {
      return {
        ok: false as const,
        error:
          "sendAtLocal must be YYYY-MM-DDTHH:mm in the owner's local time, e.g. 2026-08-14T09:00",
      };
    }
    if (sendAt.getTime() < Date.now() + MIN_LEAD_MS) {
      return {
        ok: false as const,
        error:
          `That send time is in the past or nearly so. It is currently ${nowInOwnerTz()} — ` +
          `recompute the date from that and retry, or use send_email if he wants it gone now.`,
      };
    }

    // Cap check before the insert. Same shape as snipe_resy's: show him what's
    // queued and let HIM pick what to drop — silently evicting the oldest would
    // cancel an email he's counting on.
    const { count, error: countError } = await supabase
      .from("scheduled_emails")
      .select("id", { count: "exact", head: true })
      .eq("status", "scheduled");
    if (countError) return { ok: false as const, error: countError.message };
    if ((count ?? 0) >= MAX_SCHEDULED) {
      return {
        ok: false as const,
        error:
          `There are already ${count} emails queued, which is the maximum (${MAX_SCHEDULED}). ` +
          `Call list_scheduled_emails, show the owner what's waiting, ask which to drop, cancel ` +
          `it with cancel_scheduled_email, then try again. Do NOT retry without cancelling one.`,
      };
    }

    // Confirmation target from the VERIFIED session, never from the model.
    const attrs = ctx.session.auth.current?.attributes as
      | { channel?: string; phone?: string; slackChannelId?: string }
      | undefined;
    const channel = attrs?.channel === "slack" ? "slack" : "imessage";
    const phone = channel === "imessage" ? attrs?.phone ?? process.env.OWNER_PHONE ?? null : null;
    const slackTarget =
      channel === "slack" && attrs?.slackChannelId ? { channelId: attrs.slackChannelId } : null;
    if (channel === "imessage" && !phone) {
      return { ok: false as const, error: "No phone number configured (OWNER_PHONE missing)" };
    }
    if (channel === "slack" && !slackTarget) {
      return {
        ok: false as const,
        error: "Can't target Slack from here — ask the owner to request it from a Slack DM.",
      };
    }

    const { data, error } = await supabase
      .from("scheduled_emails")
      .insert({
        to_address: input.to,
        subject: input.subject,
        body: input.body,
        send_at: sendAt.toISOString(),
        channel,
        phone,
        slack_target: slackTarget,
      })
      .select("id, send_at")
      .single();
    if (error) return { ok: false as const, error: error.message };

    return {
      ok: true as const,
      id: data.id as string,
      to: input.to,
      subject: input.subject,
      // Echo the RESOLVED instant in owner-local terms. The card could only show
      // the raw string he was handed; this is the last point at which a date
      // that landed on the wrong day is catchable, so read it back to him.
      localTime: formatLocal(data.send_at as string),
      queued: (count ?? 0) + 1,
      maxQueued: MAX_SCHEDULED,
      // Say this part out loud when you confirm — not being pinged again is the
      // entire point, and he has no other way to know it's true.
      note: "It sends itself at that time. He won't be asked again.",
    };
  },
});
