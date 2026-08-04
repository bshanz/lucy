/**
 * Measure when a venue actually releases inventory.
 *
 *   npx tsx --env-file=.env.local scripts/watch-resy-drop.ts <venueId> <targetDate> [hh:mm-hh:mm]
 *   npx tsx --env-file=.env.local scripts/watch-resy-drop.ts 6194 2026-09-04 08:40-10:30
 *
 * Resy publishes no booking-window metadata — /3/venue returns 400 and the
 * search payload carries nothing about release times. So a venue's drop rule
 * can only be learned by watching one happen, and everything written about it
 * online is hearsay. snipe_resy deliberately refuses to guess, because a snipe
 * armed for the wrong minute does not error: it polls an empty window, reports
 * a clean miss, and the table is gone.
 *
 * This watches the CALENDAR rather than /4/find, because the calendar's horizon
 * extends the instant inventory publishes and costs one cheap request. The
 * moment the target date appears it also pulls the real slots, so the output
 * records both when the drop happened and what was actually in it.
 *
 * Read-only. It never books anything.
 */
import { findSlots, formatTime, resyApiKey } from "#lib/resy.js";
import { ensureResyStore, loadResyTokens } from "#lib/resy-store.js";
import { ownerTimezone } from "#lib/reminders.js";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

const venueId = Number(process.argv[2]);
const targetDate = process.argv[3];
const range = process.argv[4] ?? "08:40-10:30";
const partySize = Number(process.argv[5] ?? 2);

if (!venueId || !/^\d{4}-\d{2}-\d{2}$/.test(targetDate ?? "")) {
  console.error("usage: watch-resy-drop.ts <venueId> <YYYY-MM-DD> [hh:mm-hh:mm] [partySize]");
  process.exit(1);
}

/** Tight enough to name the minute, loose enough not to hammer a WAF. */
const POLL_MS = 3_000;
const TZ = ownerTimezone();

const localNow = () =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hour12: false,
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).format(new Date());

const localHHMM = () => localNow().slice(0, 5);

async function calendarHorizon(headers: Record<string, string>): Promise<string | null> {
  const start = new Date().toISOString().slice(0, 10);
  const end = new Date(Date.now() + 70 * 864e5).toISOString().slice(0, 10);
  const url =
    `https://api.resy.com/4/venue/calendar?venue_id=${venueId}` +
    `&num_seats=${partySize}&start_date=${start}&end_date=${end}`;
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    const body: any = await res.json();
    const days = body?.scheduled ?? [];
    return days.length ? String(days[days.length - 1]?.date ?? "") : null;
  } catch {
    return null; // a dropped poll is noise, not a reason to stop watching
  }
}

async function main(): Promise<void> {
  ensureResyStore();
  const tokens = await loadResyTokens();
  if (!tokens) throw new Error('Resy not linked — say "connect resy" to Lucy first');

  const headers: Record<string, string> = {
    authorization: `ResyAPI api_key="${await resyApiKey()}"`,
    "x-resy-auth-token": tokens.authToken,
    "x-resy-universal-auth": tokens.authToken,
    "user-agent": UA,
    origin: "https://resy.com",
    referer: "https://resy.com/",
    accept: "application/json, text/plain, */*",
  };

  const [from, to] = range.split("-");
  console.log(`Watching venue ${venueId} for ${targetDate} (party ${partySize})`);
  console.log(`Window ${from}–${to} ${TZ}; polling every ${POLL_MS / 1000}s\n`);

  // Baseline first, so "it was already out" is distinguishable from "it dropped
  // while I watched" — otherwise a late start reports a drop that never happened.
  const before = await calendarHorizon(headers);
  console.log(`${localNow()}  horizon before: ${before ?? "unknown"}`);
  if (before && before >= targetDate) {
    console.log(`\n⚠️  ${targetDate} was ALREADY released before this started.`);
    console.log("    Nothing to measure — re-run earlier, on a date that hasn't dropped.");
    return;
  }

  while (localHHMM() < from) await new Promise((r) => setTimeout(r, 5_000));

  let polls = 0;
  while (localHHMM() <= to) {
    polls++;
    const horizon = await calendarHorizon(headers);

    if (horizon && horizon >= targetDate) {
      const at = localNow();
      console.log(`\n🎯 DROPPED at ${at} ${TZ}  (after ${polls} polls)`);
      console.log(`   horizon moved ${before ?? "?"} → ${horizon}`);

      const slots = await findSlots({ venueId, day: targetDate, partySize }).catch(() => []);
      console.log(`\n   ${slots.length} slot(s) in the drop:`);
      for (const s of slots) console.log(`     ${formatTime(s.time)}  ${s.type ?? ""}`);

      console.log(`\n   → Arm future snipes at ${at.slice(0, 5)} ${TZ}.`);
      console.log(`     Measured, not guessed. Re-measure if the venue changes its rule.`);
      return;
    }

    if (polls % 20 === 0) console.log(`${localNow()}  still ${horizon ?? "?"}`);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  console.log(`\nNo drop seen by ${to}. Either the window was wrong, or the venue`);
  console.log(`releases at a time outside it — widen the range and try the next day.`);
}

main().catch((err) => {
  console.error("\nFailed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
