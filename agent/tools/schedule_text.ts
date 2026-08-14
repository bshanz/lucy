import { defineTool } from "eve/tools";
import { z } from "zod";
import { contactCardUrl } from "#lib/contact-card.js";
import {
  MAX_SCHEDULED,
  MIN_LEAD_MS,
  contactBlock,
  normalizePhone,
  preflight,
  supabase,
} from "#lib/outbound-text.js";
import { formatLocal, nowInOwnerTz, ownerWallClockToUtc } from "#lib/reminders.js";

const BAD_NUMBER =
  "That doesn't parse as a phone number I can send to. Give it in full international form " +
  "(+1 555 123 4567). Never guess digits — check recall_memories, and if it isn't there, ask " +
  "him for the number rather than sending his words to a stranger.";

export default defineTool({
  description:
    "Text a person who is NOT the owner at a FUTURE time, from the assistant's iMessage line. " +
    "REQUIRES the owner's explicit approval — and THAT CARD IS THE AUTHORIZATION: at the " +
    "scheduled minute the message goes out EXACTLY as written here, unattended, and he is NOT " +
    "asked again. So write the FINAL text — no placeholders, nothing you plan to fill in later, " +
    "because you will not get the chance. Plain text only (iMessage renders no markdown), in HIS " +
    "voice rather than yours, short like a real text. " +
    "The first message to a number he hasn't texted before must open with the introduction line " +
    "— this tool will tell you the exact wording if you leave it out. " +
    "The card shows sendAtLocal as you typed it, so say the day and time back to him in plain " +
    "words when you ask. For a text he wants gone now, use send_text instead. " +
    "sendAtLocal is the owner's local wall clock with NO timezone offset — when he says '8am " +
    "tomorrow', pass tomorrow's date and 08:00; never convert to UTC yourself.",
  inputSchema: z.object({
    to: z.string().min(1).describe("Recipient's phone number, ideally E.164 (+15551234567)"),
    message: z
      .string()
      .min(1)
      .describe("The complete text, exactly as it should arrive on their phone. Plain text only."),
    sendAtLocal: z
      .string()
      .min(1)
      .describe("Owner-local send time, YYYY-MM-DDTHH:mm (24h), e.g. 2026-08-15T08:00"),
    attachContactCard: z
      .boolean()
      .optional()
      .describe(
        "Attach the assistant's contact card. REQUIRED (true) on the first text to a number, " +
          "and must be omitted on every text after that. The tool tells you which case you're in.",
      ),
  }),
  // Same policy as send_text, and for the same reason: the card is built from
  // this input, so anything wrong with the message has to be caught before he
  // reads it. See #lib/outbound-text.js preflight().
  approval: async ({ toolInput }) => {
    const number = normalizePhone(toolInput?.to ?? "");
    if (!number) return { type: "denied", reason: BAD_NUMBER };
    try {
      const problem =
        (await preflight(number, toolInput?.message ?? "", toolInput?.attachContactCard === true)) ??
        (await contactBlock(number));
      if (problem) return { type: "denied", reason: problem };
    } catch {
      // Fall through: better to ask a human than to skip a check we couldn't run.
    }
    return "user-approval";
  },
  async execute(input, ctx) {
    const number = normalizePhone(input.to);
    if (!number) return { ok: false as const, error: BAD_NUMBER };

    // Both halves, and this one matters more here than in send_text: there is no
    // immediate send to fail against, so an unverified recipient that isn't caught
    // now surfaces as a failed text at the hour he was counting on.
    const problem =
      (await preflight(number, input.message, input.attachContactCard === true)) ??
      (await contactBlock(number));
    if (problem) return { ok: false as const, error: problem };

    // Resolve the card NOW and store the URL, so the cron is a pure replay. Doing
    // it at send time would mean the attachment was chosen after he approved.
    let mediaUrl: string | null = null;
    if (input.attachContactCard) {
      try {
        mediaUrl = await contactCardUrl();
      } catch (err) {
        return {
          ok: false as const,
          error:
            `Couldn't prepare the contact card, so nothing was queued: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    const sendAt = ownerWallClockToUtc(input.sendAtLocal);
    if (!sendAt) {
      return {
        ok: false as const,
        error:
          "sendAtLocal must be YYYY-MM-DDTHH:mm in the owner's local time, e.g. 2026-08-15T08:00",
      };
    }
    if (sendAt.getTime() < Date.now() + MIN_LEAD_MS) {
      return {
        ok: false as const,
        error:
          `That send time is in the past or nearly so. It is currently ${nowInOwnerTz()} — ` +
          `recompute the date from that and retry, or use send_text if he wants it gone now.`,
      };
    }

    // Cap check before the insert. Same shape as schedule_email's: show him what's
    // queued and let HIM pick what to drop — silently evicting the oldest would
    // cancel a message he's counting on.
    const { count, error: countError } = await supabase
      .from("outbound_texts")
      .select("id", { count: "exact", head: true })
      .eq("status", "scheduled");
    if (countError) return { ok: false as const, error: countError.message };
    if ((count ?? 0) >= MAX_SCHEDULED) {
      return {
        ok: false as const,
        error:
          `There are already ${count} texts queued, which is the maximum (${MAX_SCHEDULED}). ` +
          `Call list_scheduled_texts, show the owner what's waiting, ask which to drop, cancel ` +
          `it with cancel_scheduled_text, then try again. Do NOT retry without cancelling one.`,
      };
    }

    // Where the "sent ✓" goes back to HIM — resolved from the VERIFIED session,
    // never from the model. (The recipient is a tool argument; the owner's own
    // channel never is.)
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
      .from("outbound_texts")
      .insert({
        to_number: number,
        body: input.message,
        media_url: mediaUrl,
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
      to: number,
      // Echo the RESOLVED instant in owner-local terms. The card could only show
      // the raw string he was handed; this is the last point at which a date that
      // landed on the wrong day is catchable, so read it back to him.
      localTime: formatLocal(data.send_at as string),
      queued: (count ?? 0) + 1,
      maxQueued: MAX_SCHEDULED,
      // Say this part out loud when you confirm — not being pinged again is the
      // entire point, and he has no other way to know it's true.
      note: "It sends itself at that time. He won't be asked again.",
    };
  },
});
