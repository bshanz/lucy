import { defineSchedule } from "eve/schedules";
import sendblue from "#channels/sendblue.js";
import { getAuthToken, redact } from "#lib/resy.js";
import { ensureResyStore, loadResyTokens } from "#lib/resy-store.js";
import { ownerLocalHour } from "#lib/reminders.js";
import { supabase } from "#lib/supabase.js";

/**
 * Keeps the Resy session alive, and shouts BEFORE it dies rather than after.
 *
 * Refreshing returns a NEW refresh token every time, so a session that gets
 * touched daily rolls its 90-day window forward indefinitely and effectively
 * never expires. That makes this cron the thing that keeps Resy connected, not
 * merely an optimisation — and it means the interesting failure is not "the
 * token aged out" but "refresh started being refused" (password changed,
 * session revoked, account action).
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
      // force=true renews on schedule rather than waiting for the token to drift
      // into its expiry margin — and each renewal rolls the refresh window
      // forward, which is what makes the session effectively permanent.
      await getAuthToken(true);
      console.log("[resy-auth] session refreshed");
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

    // Refresh worked. Belt-and-braces: if the refresh window is somehow running
    // down anyway — Lucy was deployed-down for weeks, or Resy stopped rolling it
    // forward — give real notice while a code exchange can still be scheduled
    // calmly, instead of discovering it on the morning of a drop.
    const fresh = await loadResyTokens();
    if (!fresh?.refreshExpiresAt) return;

    const daysLeft = Math.floor((fresh.refreshExpiresAt - Date.now()) / 86400_000);
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
