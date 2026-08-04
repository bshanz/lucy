import { defineTool } from "eve/tools";
import { z } from "zod";
import { ResyError, redact, verifyLoginCode } from "#lib/resy.js";
import { ensureResyStore } from "#lib/resy-store.js";

export default defineTool({
  description:
    "Finish linking Resy: exchanges the 6-digit code the owner just texted you for a stored " +
    "session. Call this immediately after he sends the code, following connect_resy. On success " +
    "the account stays linked for about 45 days and renews itself after that, so he won't have " +
    "to do this again for months — say so, briefly. If the code is wrong or stale, call " +
    "connect_resy again for a fresh one rather than guessing at digits.",
  inputSchema: z.object({
    code: z
      .string()
      .min(4)
      .max(10)
      .describe("The digits he texted you, e.g. '481920'. Strip any spaces or punctuation."),
  }),
  async execute({ code }) {
    ensureResyStore();

    const phone = process.env.OWNER_PHONE;
    if (!phone) {
      return { ok: false as const, error: "OWNER_PHONE isn't configured." };
    }

    // Codes arrive as "your code is 481920" or "481-920" once the owner retypes
    // them. Normalising here saves a pointless round trip over punctuation.
    const digits = code.replace(/\D/g, "");
    if (digits.length < 4) {
      return {
        ok: false as const,
        error: `"${code}" doesn't contain a code. Ask him to send just the digits.`,
      };
    }

    try {
      const tokens = await verifyLoginCode(phone, digits);
      return {
        ok: true as const,
        connected: true,
        // Dates only — the tokens themselves must never reach the model.
        goodUntil: tokens.authExpiresAt
          ? new Date(tokens.authExpiresAt).toISOString().slice(0, 10)
          : null,
        renewsAutomatically: tokens.refreshToken != null,
        next:
          "Confirm warmly and briefly that Resy is linked and you can book from now on. Don't " +
          "quote token details or expiry mechanics at him — just that it's done.",
      };
    } catch (err) {
      if (err instanceof ResyError) {
        // A wrong or expired code comes back as a plain rejection. Treat it as
        // routine rather than alarming — retyping a digit is the usual cause.
        if (err.kind === "bad_request" || err.kind === "auth") {
          return {
            ok: false as const,
            error:
              "Resy didn't accept that code — it may have a typo or have expired. Ask him to " +
              "check the text, or call connect_resy to send a fresh one.",
          };
        }
        return { ok: false as const, error: err.message };
      }
      return { ok: false as const, error: redact(String(err)) };
    }
  },
});
