import { defineTool } from "eve/tools";
import { z } from "zod";
import { contactCardUrl } from "#lib/contact-card.js";
import {
  contactBlock,
  explainSendFailure,
  normalizePhone,
  preflight,
  supabase,
} from "#lib/outbound-text.js";
import { sendMessageWithHandle } from "#lib/sendblue.js";

const BAD_NUMBER =
  "That doesn't parse as a phone number I can send to. Give it in full international form " +
  "(+1 555 123 4567). Never guess digits — check recall_memories, and if it isn't there, ask " +
  "him for the number rather than sending his words to a stranger.";

export default defineTool({
  description:
    "Text a person who is NOT the owner, right now, from the assistant's iMessage line. " +
    "REQUIRES the owner's explicit approval — he sees the recipient and the exact message on a " +
    "card first, and what is on that card is what arrives, character for character. So pass the " +
    "COMPLETE FINAL TEXT: plain text only (iMessage renders no markdown), written in HIS voice " +
    "rather than yours, short like a real text. " +
    "The first message to a number he hasn't texted before must open with the introduction line " +
    "— this tool will tell you the exact wording if you leave it out. " +
    "For a text he wants sent at a later time, use schedule_text instead. Never guess a phone " +
    "number: resolve it from recall_memories or ask him.",
  inputSchema: z.object({
    to: z.string().min(1).describe("Recipient's phone number, ideally E.164 (+15551234567)"),
    message: z
      .string()
      .min(1)
      .describe("The complete text, exactly as it should arrive on their phone. Plain text only."),
    attachContactCard: z
      .boolean()
      .optional()
      .describe(
        "Attach the assistant's contact card. REQUIRED (true) on the first text to a number, " +
          "and must be omitted on every text after that. The tool tells you which case you're in.",
      ),
  }),
  // Runs BEFORE the card is drawn, so a message that needs fixing is sent back to
  // you instead of being shown to him half-right. A lookup failure falls through
  // to asking him — the same way update_calendar_event handles an unreachable
  // guest list — and execute() re-checks regardless.
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
  async execute({ to, message, attachContactCard }) {
    const number = normalizePhone(to);
    if (!number) return { ok: false as const, error: BAD_NUMBER };

    // Re-run the guards. The approval policy is a UX affordance; this is where
    // the property has to actually hold.
    const problem = await preflight(number, message, attachContactCard === true);
    if (problem) return { ok: false as const, error: problem };

    // Resolved here rather than passed in: the URL is derived from env, not from
    // anything the model can choose, so the only decision on the card is whether
    // it goes — which is the boolean he approved.
    let mediaUrl: string | null = null;
    if (attachContactCard) {
      try {
        mediaUrl = await contactCardUrl();
      } catch (err) {
        return {
          ok: false as const,
          error:
            `Couldn't prepare the contact card, so nothing was sent: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    // Send FIRST, record after. The row must never exist in a claimable state for
    // a message that is already gone — text-send.ts would pick it up and send it
    // a second time.
    let handle: string | null = null;
    try {
      handle = await sendMessageWithHandle(number, message, mediaUrl);
    } catch (err) {
      const reason = explainSendFailure(err, number);
      await supabase
        .from("outbound_texts")
        .insert({
          to_number: number,
          body: message,
          media_url: mediaUrl,
          send_at: new Date().toISOString(),
          status: "failed",
          attempts: 1,
          last_error: reason.slice(0, 500),
        })
        .then(({ error }) => {
          if (error) console.error(`[send_text] couldn't log the failure: ${error.message}`);
        });
      return { ok: false as const, error: reason };
    }

    const now = new Date().toISOString();
    const { error } = await supabase.from("outbound_texts").insert({
      to_number: number,
      body: message,
      media_url: mediaUrl,
      send_at: now,
      status: "sent",
      sent_at: now,
      message_handle: handle,
      attempts: 1,
    });
    // The text is already on its way; a lost log line is not worth failing over.
    // The only consequence is that the next text to this number re-introduces him.
    if (error) console.error(`[send_text] sent but couldn't record it: ${error.message}`);

    return { ok: true as const, sentTo: number };
  },
});
