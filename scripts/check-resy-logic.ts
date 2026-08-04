/**
 * Checks the pure logic behind reservation sniping.
 * Run with `npx tsx scripts/check-resy-logic.ts`.
 *
 * These are the functions that decide what gets booked with the owner's money
 * while he's asleep, and none of them touch the network. Two failure modes are
 * worth more than the rest:
 *
 *  - rankSlots treating the time window as a PREFERENCE rather than a bound.
 *    Booking 5:30pm when he authorised 7–9 isn't a near miss, it's a table he
 *    never agreed to, and he finds out on the night.
 *  - depositWithinBounds being off by one at the cap, which either charges him
 *    over his limit or silently refuses the table he actually cleared.
 *
 * computeDropAt is covered here too because a drop time an hour out doesn't
 * error — it just loses, quietly, and the fall-back DST day is exactly when.
 */
import {
  chargeCentsFrom,
  computeDropAt,
  depositWithinBounds,
  dropAtForBookingWindow,
  formatTime,
  rankSlots,
  sessionExpiresAt,
  toMinutes,
  type ResySlot,
} from "#lib/resy.js";

let failures = 0;
function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    failures++;
    console.log(`FAIL  ${name}\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);
  } else {
    console.log(`PASS  ${name}`);
  }
}

const slot = (time: string, type: string | null = null): ResySlot => ({
  configToken: `tok-${time}-${type ?? "any"}`,
  time,
  type,
  duration: null,
});

const times = (slots: ResySlot[]) => slots.map((s) => s.time);

// ---------------------------------------------------------------------------
// rankSlots — the window is an authorisation boundary
// ---------------------------------------------------------------------------

const evening: ResySlot[] = [
  slot("17:30", "Dining Room"),
  slot("19:00", "Bar"),
  slot("19:45", "Dining Room"),
  slot("20:30", "Dining Room"),
  slot("22:00", "Dining Room"),
];

const window7to9 = {
  earliestTime: "19:00",
  latestTime: "21:00",
  preferredTime: null,
  slotTypes: null,
};

check(
  "drops everything outside the window",
  times(rankSlots(evening, window7to9)),
  ["19:00", "19:45", "20:30"],
);

check(
  "empty when nothing is inside the window",
  rankSlots([slot("17:30"), slot("22:00")], window7to9).length,
  0,
);

check(
  "boundaries are inclusive — the edges are authorised too",
  times(rankSlots([slot("19:00"), slot("21:00")], window7to9)),
  ["19:00", "21:00"],
);

check(
  "a one-minute window still matches exactly",
  times(
    rankSlots(evening, {
      earliestTime: "19:45",
      latestTime: "19:45",
      preferredTime: null,
      slotTypes: null,
    }),
  ),
  ["19:45"],
);

// Preference ordering, all inside the window.
check(
  "no preferred time — earliest first",
  times(rankSlots(evening, window7to9))[0],
  "19:00",
);

check(
  "preferred time pulls the closest slot to the front",
  times(rankSlots(evening, { ...window7to9, preferredTime: "20:30" })),
  ["20:30", "19:45", "19:00"],
);

check(
  "ties on distance break earlier (19:00 and 20:30 are equidistant from 19:45)",
  times(rankSlots(evening, { ...window7to9, preferredTime: "19:45" })),
  ["19:45", "19:00", "20:30"],
);

// Table type outranks clock distance: someone who said "dining room" meant it.
check(
  "preferred table type wins over a closer time",
  times(rankSlots(evening, { ...window7to9, preferredTime: "19:00", slotTypes: ["Dining Room"] })),
  ["19:45", "20:30", "19:00"],
);

check(
  "unlisted table types sort last but stay eligible",
  times(
    rankSlots([slot("19:30", "Counter"), slot("20:00", "Bar")], {
      ...window7to9,
      slotTypes: ["Bar"],
    }),
  ),
  ["20:00", "19:30"],
);

check(
  "slot type matching is case-insensitive and substring-based",
  times(
    rankSlots([slot("19:30", "Main Dining Room"), slot("20:00", "Bar")], {
      ...window7to9,
      slotTypes: ["dining room"],
    }),
  ),
  ["19:30", "20:00"],
);

check("no slots in, no slots out", rankSlots([], window7to9).length, 0);

// ---------------------------------------------------------------------------
// depositWithinBounds — exact behaviour at the cap
// ---------------------------------------------------------------------------

check("free table with a zero cap", depositWithinBounds(0, 0), true);
check("any deposit refused when cap is zero", depositWithinBounds(1, 0), false);
check("deposit exactly at the cap is authorised", depositWithinBounds(5000, 5000), true);
check("one cent over the cap is refused", depositWithinBounds(5001, 5000), false);
check("well under the cap", depositWithinBounds(2500, 5000), true);

// ---------------------------------------------------------------------------
// chargeCentsFrom — the one unit boundary, using real captured payloads
// ---------------------------------------------------------------------------
//
// Resy reports money in DOLLARS; everything here counts cents. Reading `total`
// as cents makes a $400 prix fixe look like $4 and walk straight through a $50
// cap — a silent overspend of the owner's money, which is the worst failure this
// feature can have. Both payloads below are copied verbatim from live responses.

// Chef's Table at Brooklyn Fare, party of 2, rendered "$200.00 x 2 = $400.00".
const brooklynFare = {
  amounts: {
    reservation_charge: 400, subtotal: 400, add_ons: 0, quantity: 2,
    resy_fee: 0, service_fee: 0, tax: 0, total: 400, surcharge: 0, price_per_unit: 200,
  },
  config: { type: "prix fixe" },
};
// The Garage — an ordinary free table that still demands a card on file.
const freeTable = {
  amounts: {
    items: [], reservation_charge: 0, subtotal: 0, add_ons: 0, quantity: 2,
    resy_fee: 0, service_fee: 0, tax: 0, total: 0, surcharge: 0, price_per_unit: 0,
  },
  config: { type: "free" },
};

check("$400 prix fixe reads as 40000 cents, not 400", chargeCentsFrom(brooklynFare), 40_000);
check("a free table is zero", chargeCentsFrom(freeTable), 0);
check("total already includes quantity — no multiplying by party size", chargeCentsFrom(brooklynFare), 200 * 2 * 100);
check("missing payment block is zero, not NaN", chargeCentsFrom(undefined), 0);
check("missing amounts is zero", chargeCentsFrom({ config: { type: "free" } }), 0);
check("falls back to reservation_charge when total is absent", chargeCentsFrom({ amounts: { reservation_charge: 25 } }), 2_500);
check("garbage is zero, never NaN", chargeCentsFrom({ amounts: { total: "abc" } }), 0);
check("fractional dollars round to whole cents", chargeCentsFrom({ amounts: { total: 12.345 } }), 1_235);

// A $400 charge must NOT pass a $50 cap. This is the composed failure the two
// bugs would have produced together: no deposit parsed, so no cap enforced.
check("the $400 prix fixe is refused by a $50 cap", depositWithinBounds(chargeCentsFrom(brooklynFare), 5_000), false);
check("the free table passes a zero cap", depositWithinBounds(chargeCentsFrom(freeTable), 0), true);

// ---------------------------------------------------------------------------
// sessionExpiresAt — which clock actually governs
// ---------------------------------------------------------------------------
//
// This one is worth a test precisely because getting it wrong is INVISIBLE.
// An OTP-linked account has no refresh token, so reading refresh_expires_at
// yields null, every expiry check short-circuits to "nothing to warn about",
// and the first symptom is a snipe that didn't fire six weeks later.

const DAY = 86400_000;
const authOnly = {
  authToken: "a",
  refreshToken: null,
  authExpiresAt: 1000 * DAY,
  refreshExpiresAt: null,
};
const withRefresh = {
  authToken: "a",
  refreshToken: "r",
  authExpiresAt: 1000 * DAY,
  refreshExpiresAt: 2000 * DAY,
};

check(
  "code-linked session is governed by the AUTH token expiry",
  sessionExpiresAt(authOnly),
  1000 * DAY,
);
check(
  "password-linked session is governed by the REFRESH expiry",
  sessionExpiresAt(withRefresh),
  2000 * DAY,
);
check(
  "a refresh token with no stated expiry doesn't silently fall back to the auth clock",
  sessionExpiresAt({ ...withRefresh, refreshExpiresAt: null }),
  null,
);
check(
  "an opaque token with no expiry at all reports unknown, not zero",
  sessionExpiresAt({ ...authOnly, authExpiresAt: null }),
  null,
);

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

check("toMinutes midnight", toMinutes("00:00"), 0);
check("toMinutes 19:45", toMinutes("19:45"), 1185);
check("formatTime noon", formatTime("12:00"), "12pm");
check("formatTime midnight", formatTime("00:00"), "12am");
check("formatTime 19:45", formatTime("19:45"), "7:45pm");
check("formatTime drops :00", formatTime("19:00"), "7pm");

// ---------------------------------------------------------------------------
// Drop-time maths — where a silent loss comes from
// ---------------------------------------------------------------------------

const OWNER_TZ = process.env.OWNER_TIMEZONE ?? "(unset — defaults inside reminders.ts)";
console.log(`\n  (drop-time checks run in OWNER_TIMEZONE=${OWNER_TZ})`);

const drop = computeDropAt("2026-08-31T09:00");
check("computeDropAt returns an instant", drop instanceof Date && !Number.isNaN(drop.getTime()), true);
check("computeDropAt rejects garbage", computeDropAt("next tuesday"), null);
check("computeDropAt rejects an offset-bearing string", computeDropAt("2026-08-31T09:00:00Z"), null);

// "30 days out at 9am" for a Sept 30 table => Aug 31, 09:00 local.
const window = dropAtForBookingWindow("2026-09-30", 30, "09:00");
check(
  "dropAtForBookingWindow lands 30 days earlier",
  window ? window.toISOString().slice(0, 10) : null,
  computeDropAt("2026-08-31T09:00")?.toISOString().slice(0, 10) ?? null,
);
check("dropAtForBookingWindow rejects a bad date", dropAtForBookingWindow("not-a-date", 30, "09:00"), null);

// The DST fall-back day. In US zones the clocks go back on 2026-11-01, so a
// 9am local drop that day sits at a different UTC offset than the day before.
// If these two ever come out 24h apart in UTC terms, the offset maths is wrong
// and every snipe across that weekend fires an hour late.
const beforeFallBack = computeDropAt("2026-10-31T09:00");
const afterFallBack = computeDropAt("2026-11-01T09:00");
if (beforeFallBack && afterFallBack) {
  const gapHours = (afterFallBack.getTime() - beforeFallBack.getTime()) / 3600_000;
  // 24h in a zone with no DST shift, 25h in a US zone falling back. Both are
  // correct; 23h or anything else means the wall clock was not honoured.
  check("9am holds across the DST fall-back day (24h or 25h gap)", gapHours === 24 || gapHours === 25, true);
  console.log(`        gap was ${gapHours}h`);
} else {
  failures++;
  console.log("FAIL  DST fall-back day did not resolve");
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
