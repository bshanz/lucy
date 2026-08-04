/**
 * Verifies the Resy integration against the real API, without booking anything.
 * Run with `npx tsx --env-file=.env.local scripts/check-resy-live.ts`.
 *
 * Climbs the ladder in order and stops at the first broken rung, because each
 * step is a precondition for the next:
 *
 *   1. scrape the rotating API key out of resy.com's bundle
 *   2. venue search           (unauthenticated)
 *   3. stored session         (needs the account linked via connect_resy)
 *   4. availability           (authenticated)
 *   5. resolve one slot to a booking token — AND STOP
 *
 * Step 5 deliberately goes no further. Holding a book_token costs nothing and
 * expires on its own in about five minutes; calling /3/book would create a real
 * reservation someone then has to remember to cancel. Proving we can obtain the
 * token proves the whole path bar the final POST.
 *
 * Steps 3–5 are SKIPPED, not failed, when the account isn't linked, so this is
 * also the right thing to run before setting Resy up at all.
 *
 * This script never TRIGGERS a login code. Asking Resy for one texts the owner's
 * phone, which is a real-world side effect and belongs to an action he asked
 * for — connect_resy — not to a diagnostic he might run twice while poking around.
 */
import {
  ResyError,
  findSlots,
  formatTime,
  getAuthToken,
  jwtExpiry,
  rankSlots,
  resyApiKey,
  slotDetails,
  snipeBlocker,
  venueSearch,
} from "#lib/resy.js";
import { ensureResyStore, loadResyTokens } from "#lib/resy-store.js";

const QUERY = process.argv[2] ?? "Carbone";

let failures = 0;
let skipped = 0;

function pass(name: string, detail = ""): void {
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
}
function fail(name: string, detail: string): void {
  failures++;
  console.log(`FAIL  ${name} — ${detail}`);
}
function skip(name: string, why: string): void {
  skipped++;
  console.log(`SKIP  ${name} — ${why}`);
}

/** Tomorrow, in the crude sense that's fine for an availability probe. */
function soon(daysOut: number): string {
  return new Date(Date.now() + daysOut * 86400_000).toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  ensureResyStore();

  // --- 1. The rotating key. Every Resy bot on GitHub hardcodes a key that is
  // now dead and returns 419; this is the check that we didn't inherit that bug.
  let key: string;
  try {
    key = await resyApiKey();
    pass("scrape API key from resy.com bundle", `…${key.slice(-6)} (${key.length} chars)`);
  } catch (err) {
    fail("scrape API key", String(err));
    return; // nothing else can work
  }

  // --- 2. Venue search, unauthenticated.
  let venues;
  try {
    venues = await venueSearch(QUERY, 5);
  } catch (err) {
    fail("venue search", String(err));
    return;
  }
  if (venues.length === 0) {
    fail("venue search", `no venues matched "${QUERY}"`);
    return;
  }
  pass("venue search (unauthenticated)", `${venues.length} match(es) for "${QUERY}"`);

  for (const v of venues) {
    const blocker = snipeBlocker(v, 2);
    console.log(
      `        ${String(v.id).padEnd(8)} ${v.name} — ${v.city ?? "?"} · ` +
        `max ${v.maxPartySize ?? "?"} · ${blocker ? "NOT snipeable" : "snipeable"}`,
    );
  }

  // The per-venue reCAPTCHA flag is the constraint most likely to surprise
  // someone: it varies between locations of the SAME restaurant.
  const blocked = venues.filter((v) => snipeBlocker(v, 2) !== null);
  if (blocked.length > 0) {
    console.log(
      `        (${blocked.length} of these can't be auto-booked — snipe_resy will refuse them)`,
    );
  }

  // --- 3. The stored session. Deliberately does NOT mint one: getAuthToken can
  // only reach the network here to REFRESH an existing session, never to start
  // one, because starting one texts a code to a real phone.
  const stored = await loadResyTokens();
  if (!stored) {
    skip("stored session", 'Resy not linked yet — say "connect resy" to Lucy');
    skip("availability (authenticated)", "not linked");
    skip("resolve a booking token", "not linked");
    return;
  }

  let token: string;
  try {
    token = await getAuthToken();
    const exp = jwtExpiry(token);
    const refreshDays = stored.refreshExpiresAt
      ? Math.floor((stored.refreshExpiresAt - Date.now()) / 86400_000)
      : null;
    pass(
      "stored session valid",
      (exp ? `token expires ${new Date(exp).toISOString().slice(0, 10)}` : "opaque token") +
        (refreshDays !== null ? `, refresh window ${refreshDays}d` : ""),
    );
  } catch (err) {
    // On an OTP-only account there is no unattended way back from here — the
    // owner has to re-link. Say that rather than implying a config fix.
    fail(
      "stored session",
      (err instanceof ResyError ? err.message : String(err)) +
        ' — re-link by saying "connect resy" to Lucy',
    );
    return;
  }

  // --- 4. Availability on a real venue, far enough out to plausibly have tables.
  const venue = venues.find((v) => snipeBlocker(v, 2) === null) ?? venues[0];
  const day = soon(21);
  let slots;
  try {
    slots = await findSlots({ venueId: venue.id, day, partySize: 2 });
    pass("availability (authenticated)", `${slots.length} slot(s) at ${venue.name} on ${day}`);
  } catch (err) {
    fail("availability", err instanceof ResyError ? err.message : String(err));
    return;
  }

  if (slots.length === 0) {
    skip(
      "resolve a booking token",
      `nothing open at ${venue.name} on ${day} — re-run with a different restaurant, ` +
        `e.g. \`npx tsx --env-file=.env.local scripts/check-resy-live.ts "some easier place"\``,
    );
    return;
  }

  for (const s of slots.slice(0, 5)) {
    console.log(`        ${formatTime(s.time)}  ${s.type ?? "(no type)"}`);
  }

  // Exercise the ranker against real data, not just fixtures.
  const ranked = rankSlots(slots, {
    earliestTime: "17:00",
    latestTime: "22:00",
    preferredTime: "19:30",
    slotTypes: null,
  });
  pass("rank real slots", `${ranked.length} inside 5–10pm, best is ${ranked.length ? formatTime(ranked[0].time) : "n/a"}`);
  if (ranked.length === 0) {
    skip("resolve a booking token", "no slots inside the test window");
    return;
  }

  // --- 5. Booking token, then STOP. One more call would be a real reservation.
  try {
    const details = await slotDetails({
      configToken: ranked[0].configToken,
      day,
      partySize: 2,
    });
    pass(
      "resolve a booking token (NOT booked)",
      `token ok, deposit ${details.depositCents === 0 ? "none" : `${details.depositCents}c`}, ` +
        `card on file: ${details.paymentMethodId != null ? "yes" : "no"}`,
    );
    console.log("        stopping here on purpose — booking would create a real reservation");
  } catch (err) {
    fail("resolve a booking token", err instanceof ResyError ? err.message : String(err));
  }
}

main()
  .then(() => {
    const summary = `${failures} failed, ${skipped} skipped`;
    console.log(failures === 0 ? `\nLive checks OK (${summary}).` : `\n${summary}`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error("\nCheck script itself failed:", err);
    process.exit(1);
  });
