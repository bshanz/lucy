import { defineSchedule } from "eve/schedules";
import sendblue from "#channels/sendblue.js";
import { getAuthToken, redact, sessionExpiresAt } from "#lib/resy.js";
import { ensureResyStore, loadResyTokens } from "#lib/resy-store.js";
import { ownerLocalHour } from "#lib/reminders.js";
import { supabase } from "#lib/supabase.js";

/**
 * Keeps the Resy session alive, and shouts BEFORE it dies rather than after.
 *
 * ⚠️ WHAT THIS CAN AND CANNOT DO depends on how the account was linked, and the
 * difference is total. A PASSWORD-linked account gets a refresh token, and each
 * refresh returns a new one, so touching it daily rolls the window forward
 * indefinitely and the session never expires. A CODE-linked account — which is
 * what OTP login produces, and what this deployment has — gets `token` and
 * `legacy_token` and NO refresh token. Nothing here can extend it. The 45-day
 * clock simply runs down and the owner must text a fresh code.
 *
 * So on this account the cron is not a renewer, it is a smoke alarm. Its whole
 * job is to notice the expiry coming and say so while there is still time.
 *
 * ⚠️ THIS ACCOUNT HAS NO PASSWORD. Resy logs in by texted code, so there is no
 * unattended way back once a session is gone: the owner has to run connect_resy
 * and text six digits. Every armed snipe is dead until he does. That asymmetry
 * is why this warns early and by name instead of failing quietly at 9am on the
 * morning of a drop.
 *
 * Runs hourly, acts once at 4am owner-local. Gating on the local hour is the
 * repo's convention (Vercel evaluates cron in UTC with no DST), and it doubles
 * as the dedupe: the other 23 invocations return immediately, so "warn on day
 * 7, 3 and 1" needs no extra state and no extra table.
 *
 * `eve dev` never fires crons — trigger locally with
 * `curl -X POST http://localhost:3000/eve/v1/dev/schedules/resy-auth`.
 */

const REFRESH_HOUR = 4;
/** Days-remaining values that earn a text. Three warnings, not a daily drumbeat. */
const WARN_AT_DAYS = [7, 3, 1];

async function armedSnipeCount(): Promise<number> {
  const { count, error } = await supabase
    .from("resy_snipes")
    .select("id", { count: "exact", head: true })
    .in("status", ["armed", "firing"]);
  if (error) {
    console.error("[resy-auth] couldn't count armed snipes:", error.message);
    return 0;
  }
  return count ?? 0;
}

async function text(
  receive: Parameters<NonNullable<Parameters<typeof defineSchedule>[0]["run"]>>[0]["receive"],
  appAuth: unknown,
  message: string,
): Promise<void> {
  const phone = process.env.OWNER_PHONE;
  if (!phone) return;
  await receive(sendblue, { message, target: { phone }, auth: appAuth as never });
}

export default defineSchedule({
  cron: "0 * * * *",
  async run({ receive, appAuth }) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) return;
    if (ownerLocalHour() !== REFRESH_HOUR) return;
    ensureResyStore();

    // Never connected is not a problem to report. Don't nag about a feature the
    // owner hasn't asked for yet.
    const existing = await loadResyTokens();
    if (!existing) return;

    try {
      // Doubles as the liveness probe. On a password-linked account force=true
      // genuinely renews; on a code-linked one there is nothing to renew, so
      // this just confirms the stored token still works — and throws, landing in
      // the catch below, once it doesn't.
      await getAuthToken(true);
      console.log("[resy-auth] session ok");
    } catch (err) {
      console.error("[resy-auth] refresh failed:", redact(String(err)));

      const armed = await armedSnipeCount();
      try {
        await text(
          receive,
          appAuth,
          `Lucy's connection to Resy has stopped working and can't fix itself — this account ` +
            `signs in with a texted code, so it needs the owner. ` +
            (armed > 0
              ? `There ${armed === 1 ? "is" : "are"} ${armed} reservation snipe${armed === 1 ? "" : "s"} ` +
                `armed right now that will NOT book until it's sorted. `
              : `Nothing is armed right now, so nothing is at risk yet. `) +
            `Tell him in one or two short lines, and say he just needs to say "connect resy" ` +
            `and text you the code. Don't paste any error text and don't speculate about why.`,
        );
      } catch (notifyErr) {
        console.error("[resy-auth] couldn't warn the owner", notifyErr);
      }
      return;
    }

    // The session is alive. Now: how long has it actually got?
    //
    // ⚠️ On a code-linked account this is the ONLY thing standing between the
    // owner and a silent expiry, because there is no refresh token to roll the
    // window forward — the 45-day auth token simply runs out and every armed
    // snipe dies with it. sessionExpiresAt picks the field that actually
    // governs; reading refresh_expires_at directly returns null here and would
    // make this whole branch a no-op, which is precisely the failure it exists
    // to prevent.
    const fresh = await loadResyTokens();
    if (!fresh) return;

    const expiresAt = sessionExpiresAt(fresh);
    if (!expiresAt) return;

    const daysLeft = Math.floor((expiresAt - Date.now()) / 86400_000);
    if (!WARN_AT_DAYS.includes(daysLeft)) return;

    const armed = await armedSnipeCount();
    try {
      await text(
        receive,
        appAuth,
        `Lucy's Resy login expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"} and has to be ` +
          `renewed by hand, because this account signs in with a texted code. ` +
          (armed > 0 ? `${armed} snipe${armed === 1 ? "" : "s"} armed behind it. ` : "") +
          `Tell him in one short line, no alarm: whenever he has a moment, say "connect resy" ` +
          `and text you the code. Mention it takes about ten seconds.`,
      );
    } catch (notifyErr) {
      console.error("[resy-auth] couldn't send expiry warning", notifyErr);
    }
  },
});
