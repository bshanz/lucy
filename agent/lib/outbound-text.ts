import { toImessageText } from "#lib/imessage-format.js";
import { isKnownContact } from "#lib/sendblue.js";
import { supabase } from "#lib/supabase.js";

/**
 * Shared types, bounds and recipient handling for texts sent to people who are
 * not the owner.
 *
 * The timezone and formatting helpers deliberately live in #lib/reminders.js and
 * are imported by the callers rather than reimplemented here, for the same reason
 * #lib/scheduled-email.js gives: ownerWallClockToUtc already converges across DST
 * boundaries, and a second copy of that arithmetic is a second place for an 8am
 * text to go out at 7am in November.
 */
export type OutboundTextChannel = "imessage" | "slack";

export interface OutboundTextRow {
  id: string;
  to_number: string;
  body: string;
  media_url: string | null;
  send_at: string;
  channel: OutboundTextChannel;
  phone: string | null;
  slack_target: { channelId: string; threadTs?: string } | null;
  status: "scheduled" | "sending" | "sent" | "cancelled" | "failed";
  claimed_at: string | null;
  sent_at: string | null;
  message_handle: string | null;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * A backstop, not a quota. Nothing here is metered — the cap exists because a
 * model that has misread a conversation can queue outbound messages as fast as it
 * can call a tool, and twenty is far past any real use while still being a number
 * a person would notice.
 */
export const MAX_SCHEDULED = 20;

/**
 * Refuse a send time this close to now. Same 120s as scheduled email, same
 * reasoning: a text that fires the moment you approve it isn't scheduling, it's
 * send_text with extra steps and no chance to catch a mistake on the card.
 */
export const MIN_LEAD_MS = 120_000;

/** A 'sending' row older than this was orphaned by a crash mid-send. */
export const STUCK_MS = 10 * 60_000;

/**
 * Normalise a recipient to E.164, or refuse.
 *
 * ⚠️ THE REFUSAL IS THE POINT. The tempting behaviour for a ten-digit number with
 * no country code is to assume the owner's — but "assume" here means picking which
 * country a stranger's phone is in, and getting it wrong sends his words to
 * whoever holds that number in the country we guessed. So the NANP default is
 * applied only when the owner's own number is NANP, which is the one case where
 * a bare ten digits is genuinely unambiguous. Everything else comes back null and
 * the tool asks him for the number in full.
 *
 * Normalising also matters for the first-contact lookup: "(555) 123-4567" and
 * "+15551234567" have to be the same person, or he re-introduces himself forever.
 */
export function normalizePhone(input: string): string | null {
  const trimmed = input.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;

  if (trimmed.startsWith("+")) {
    // E.164 allows up to 15 digits; below 8 is not a reachable international number.
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }

  const ownerIsNanp = (process.env.OWNER_PHONE ?? "").startsWith("+1");
  if (!ownerIsNanp) return null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/**
 * Has a text to this number ever actually left the line?
 *
 * Only 'sent' counts. A queued text is a message the recipient has not seen, and
 * a failed one is a message that never arrived — treating either as prior contact
 * drops the introduction from the first message they genuinely receive.
 */
export async function hasTextedBefore(number: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("outbound_texts")
    .select("id")
    .eq("to_number", number)
    .eq("status", "sent")
    .limit(1);
  if (error) throw new Error(error.message);
  return (data ?? []).length > 0;
}

/**
 * The line that opens the first text to a number.
 *
 * These leave from SENDBLUE_FROM_NUMBER — Lucy's line — not from the owner's own
 * phone, which is the one way this differs from the email path, where mail comes
 * from his real address and needs no explanation. Without this the recipient gets
 * an unexplained text from a number they don't have saved.
 */
export function introLine(): string {
  const first = (process.env.OWNER_NAME || "").split(" ")[0];
  return first
    ? `Hey, it's ${first} — this is my assistant's number.`
    : "Hey — this number is my assistant's, not the one you have saved for me.";
}

/**
 * Everything that must be true of a text before the owner is ever asked about it.
 * Returns a reason to refuse, or null to proceed.
 *
 * ⚠️ THIS VERIFIES, IT DOES NOT COMPOSE, and that is the whole design.
 *
 * The iMessage approval card is built by iterating the tool's input
 * (agent/channels/sendblue.ts:437) — so what the model passes is literally what he
 * reads before saying yes. A tool that prepended an introduction or stripped
 * markdown inside execute() would be showing him one message and sending another,
 * which is exactly the property the scheduled-send path exists to guarantee.
 *
 * So the model has to pass the finished text, and this runs from the `approval`
 * policy — before any card is drawn. A message that needs changing is refused
 * with the change spelled out, the model retries, and the only card he ever sees
 * is byte-identical to what leaves the line.
 */
export async function preflight(
  number: string,
  message: string,
  attachContactCard: boolean,
): Promise<string | null> {
  if (number === normalizePhone(process.env.OWNER_PHONE ?? "")) {
    return (
      "That's the owner's own number. These tools are for texting other people — to say " +
      "something to him, just say it in the conversation, or use create_reminder if it's " +
      "meant to reach him later."
    );
  }

  // iMessage renders no markdown — asterisks arrive as asterisks. Catching it
  // here rather than silently rewriting keeps card and wire the same bytes.
  if (toImessageText(message) !== message) {
    return (
      "That message contains markdown, and iMessage renders none of it — the asterisks, " +
      "brackets and backticks would arrive literally. Rewrite it as plain text and call " +
      "again with exactly the characters that should show up on their phone."
    );
  }

  const firstContact = !(await hasTextedBefore(number));

  if (firstContact) {
    const intro = introLine();
    if (!message.startsWith(intro)) {
      return (
        `This is the first text to ${number}, and it arrives from the assistant's line rather ` +
        `than the owner's own phone, so it has to say who it is. Call again with the message ` +
        `beginning EXACTLY: "${intro}" — then a space, then what he actually wants to say. ` +
        `Don't reword it, and don't add it to later texts to this number.`
      );
    }
    if (!attachContactCard) {
      return (
        `This is the first text to ${number}, so it must also carry the contact card — pass ` +
        `attachContactCard: true. The card is what makes every LATER text show up under a name ` +
        `instead of an unknown number; the intro sentence only explains this one. It appears on ` +
        `the approval card so the owner can see it's going.`
      );
    }
  } else if (attachContactCard) {
    return (
      `Don't attach the contact card to ${number} — the owner has texted them before, so they ` +
      `have already had it. Call again with attachContactCard omitted. Re-sending a vCard on ` +
      `every message is how a person ends up muting the number.`
    );
  }

  return null;
}

/**
 * The recipient half of the same gate, split out because it costs a network call
 * and preflight() does not — which keeps the message rules provable offline in
 * scripts/check-text-claim.ts.
 *
 * A number Sendblue has never heard of cannot be messaged, and finding that out at
 * 8am tomorrow — after he wrote it, approved it and stopped thinking about it — is
 * the worst possible time. So it runs at arm time, from the same approval policy.
 *
 * Only a definite `false` refuses. `true` proves nothing (see isKnownContact) and
 * an unreachable lookup must not become a "no".
 */
export async function contactBlock(number: string): Promise<string | null> {
  return (await isKnownContact(number)) === false ? unverifiedContactMessage(number) : null;
}

/**
 * The single line a friend gets back the first time they reply.
 *
 * ⚠️ A CONSTANT, NOT A GENERATION. text-replies.ts sends this straight through
 * sendMessage() with no model turn anywhere near it, which is what makes it
 * impossible for anything written in an inbound text to change what the owner's
 * line says to a third party. It also says the true thing rather than the polite
 * one: nobody is reading this number in real time, so it must not imply someone
 * is. No pronouns for the owner — the committed persona stays generic.
 */
export function autoReplyText(): string {
  const owner = process.env.OWNER_NAME;
  return owner
    ? `This is ${owner}'s assistant — I've passed that along. I don't reply from this number.`
    : "This is an assistant line — I've passed that along, but I don't reply from this number.";
}

const autoReplyKey = (number: string) => `text_autoreply:${number}`;

/** Have they already had the one-time acknowledgement? */
export async function hasAutoReplied(number: string): Promise<boolean> {
  const { data } = await supabase
    .from("channel_state")
    .select("key")
    .eq("key", autoReplyKey(number))
    .maybeSingle();
  return Boolean(data);
}

export async function markAutoReplied(number: string): Promise<void> {
  const { error } = await supabase.from("channel_state").upsert(
    {
      key: autoReplyKey(number),
      value: { sent_at: new Date().toISOString() },
      updated_at: new Date().toISOString(),
    },
    { onConflict: "key" },
  );
  if (error) console.error(`[outbound-text] couldn't record the auto-reply: ${error.message}`);
}

/** The one thing that fixes an unverified recipient, phrased so it can be acted on. */
export function unverifiedContactMessage(number: string): string {
  const line = process.env.SENDBLUE_FROM_NUMBER ?? "the assistant's number";
  return (
    `Sendblue won't deliver to ${number} yet — on the free shared line a person has to text ` +
    `the line once before it can message them, and adding them as a contact does NOT count. ` +
    `Tell the owner plainly: ask them to send any message to ${line}, and it works from then ` +
    `on, permanently. Don't retry until that's happened.`
  );
}

/**
 * Turn a Sendblue send failure into something the owner can act on.
 *
 * The unverified-contact case is matched on the live wording, captured from the
 * API rather than guessed: a POST to an unknown number returns HTTP 400 with
 * `error_message: "This contact must be verified before sending messages to it."`
 * The looser patterns are a hedge against that string being reworded; the raw
 * error is always carried through, because a confident wrong diagnosis is worse
 * than an ugly honest one.
 */
export function explainSendFailure(err: unknown, number: string): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/must be verified|not verified|unverified contact/i.test(raw)) {
    return unverifiedContactMessage(number);
  }
  if (/contact|verif|not allowed|unauthorized|403/i.test(raw)) {
    return `${unverifiedContactMessage(number)} (Raw error: ${raw})`;
  }
  return raw;
}

export { supabase };
