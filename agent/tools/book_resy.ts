import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import {
  ResyError,
  book,
  depositWithinBounds,
  formatUsd,
  notConnectedMessage,
  redact,
  slotDetails,
} from "#lib/resy.js";
import { ensureResyStore } from "#lib/resy-store.js";

export default defineTool({
  description:
    "Book a table that is available RIGHT NOW. REQUIRES the owner's explicit approval — this " +
    "creates a real reservation he is on the hook for, and many venues charge for a no-show. " +
    "Get configToken from resy_availability in this same turn: tokens go stale and tables get " +
    "taken, so never reuse one from earlier in the conversation. If a deposit is required and " +
    "it exceeds maxDepositCents, nothing is booked and you must go back to him with the amount.",
  inputSchema: z.object({
    configToken: z.string().min(1).describe("From resy_availability, THIS turn"),
    date: z.string().describe("YYYY-MM-DD, must match the availability lookup"),
    partySize: z.number().int().min(1).max(20),
    maxDepositCents: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Deposit ceiling in CENTS. Default 0 = refuse anything requiring a card."),
  }),
  approval: always(),
  async execute({ configToken, date, partySize, maxDepositCents }) {
    ensureResyStore();
    const cap = maxDepositCents ?? 0;

    try {
      // Two steps, and the gap between them is where tables are lost. Nothing
      // to be done about that here — this path is for tables that are sitting
      // open, not for a drop race. resy-snipe.ts is what handles contention.
      const details = await slotDetails({ configToken, day: date, partySize });

      if (!depositWithinBounds(details.depositCents, cap)) {
        return {
          ok: false as const,
          error:
            `That table needs a ${formatUsd(details.depositCents)} deposit, which is over the ` +
            `${formatUsd(cap)} you cleared. Nothing was booked. Tell the owner the exact amount ` +
            `and ask whether to go ahead.`,
        };
      }

      const result = await book({
        bookToken: details.bookToken,
        // Only attach a card when Resy actually wants one. Sending it
        // unconditionally is how a "free" reservation quietly becomes a charged
        // one at venues that will take payment if offered.
        paymentMethodId: details.depositCents > 0 ? details.paymentMethodId : null,
      });

      return {
        ok: true as const,
        booked: true,
        date,
        partySize,
        confirmationId: result.reservationId,
        // Needed by cancel_resy_booking. Scoped to this one reservation — it
        // can release this table and nothing else.
        resyToken: result.resyToken,
        depositPaid: details.depositCents > 0 ? formatUsd(details.depositCents) : null,
      };
    } catch (err) {
      if (err instanceof ResyError) {
        if (err.kind === "gone") {
          return {
            ok: false as const,
            error:
              "That table went while we were booking it. Nothing was reserved. Re-run " +
              "resy_availability and tell him what's left.",
          };
        }
        if (err.kind === "payment_required") {
          return {
            ok: false as const,
            error:
              "Resy wants a deposit for that table and there's no card on file it can use. " +
              "Nothing was booked — he'll need to add a payment method in the Resy app.",
          };
        }
        if (err.kind === "recaptcha") {
          return {
            ok: false as const,
            error:
              "That venue makes you solve a reCAPTCHA to book, so I can't complete it. Nothing " +
              "was booked — send him to the Resy app or site for this one.",
          };
        }
        if (err.kind === "not_configured" || err.kind === "needs_login") {
          return { ok: false as const, error: notConnectedMessage(err.kind) };
        }
        return { ok: false as const, error: err.message };
      }
      return { ok: false as const, error: redact(String(err)) };
    }
  },
});
