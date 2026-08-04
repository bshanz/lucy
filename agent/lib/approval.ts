import type { Approval } from "eve/tools/approval";

/**
 * Approval policy for Resy actions that spend money.
 *
 * Gated by default, because this repo is public and a clone that books
 * restaurant tables without asking would be a genuinely nasty surprise. The
 * owner of a given deployment opts out with `RESY_AUTO_APPROVE=1`.
 *
 * ⚠️ Turning it off does NOT make booking unbounded, and that distinction is
 * the whole reason it's safe to offer. The approval card was never the only
 * control — the real limits are enforced in code and survive it:
 *
 *   - the seating window (rankSlots filters, it does not merely prefer)
 *   - the deposit cap (depositWithinBounds, checked before every /3/book)
 *   - the venue guard (snipeBlocker, at arm time)
 *   - the active-snipe cap, and the claim that prevents double-booking
 *
 * What the card actually adds is a human reading those bounds back before they
 * take effect. An owner who has already read them once and wants the friction
 * gone is making a reasonable trade, not disabling the safety system.
 *
 * Deliberately NOT applied to cancel_resy_booking: cancelling is destructive,
 * is never time-critical the way a drop is, and the argument for skipping the
 * gate ("a table vanishes in seconds") simply doesn't apply to giving one back.
 *
 * Env is read per-call, not at module load: eve imports tool modules during
 * discovery in an env-less sandbox.
 */
export const spendApproval: Approval = () =>
  process.env.RESY_AUTO_APPROVE === "1" ? "approved" : "user-approval";
