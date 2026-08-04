import { defineTool } from "eve/tools";
import { z } from "zod";
import { ResyError, redact, requestLoginCode } from "#lib/resy.js";
import { ensureResyStore } from "#lib/resy-store.js";

export default defineTool({
  description:
    "Start linking the owner's Resy account: asks Resy to TEXT a 6-digit login code to his " +
    "phone. Call this when he says to connect/link/reconnect Resy, or when another Resy tool " +
    "reports the account isn't connected or needs re-authorising. Then tell him a code is on " +
    "the way and ask him to text it to you, and call verify_resy_code with it. The code is " +
    "short-lived, so do that in the same conversation — don't go quiet in between.",
  inputSchema: z.object({}),
  async execute() {
    ensureResyStore();

    // ⚠️ The number comes from env, NEVER from the model. If a tool argument
    // could set it, anything that talked its way into a prompt could have Resy
    // text a login code to a phone the owner doesn't control — which is an
    // account takeover, not a misfire. Same rule as delivery targets everywhere
    // else in this codebase: identity comes from verified config, not from text.
    const phone = process.env.OWNER_PHONE;
    if (!phone) {
      return {
        ok: false as const,
        error: "OWNER_PHONE isn't configured, so I don't know where Resy should send the code.",
      };
    }

    try {
      await requestLoginCode(phone);
    } catch (err) {
      if (err instanceof ResyError && err.kind === "recaptcha") {
        return {
          ok: false as const,
          error:
            "Resy is asking for a captcha before it'll send a login code, which I can't solve. " +
            "Tell the owner he'll need to sign in on resy.com or the app this time.",
        };
      }
      const message = err instanceof ResyError ? err.message : redact(String(err));
      return { ok: false as const, error: message };
    }

    // Last 4 only — enough for him to confirm it's the right phone, without
    // echoing his full number into a transcript.
    return {
      ok: true as const,
      codeSentTo: `•••• ${phone.slice(-4)}`,
      next:
        "Tell him a 6-digit code is on its way by text and ask him to send it over. When he " +
        "does, call verify_resy_code with it. Don't ask for his password — this account uses codes.",
    };
  },
});
