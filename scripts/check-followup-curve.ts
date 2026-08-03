/**
 * Checks the reminder follow-up curve. Run with `npx tsx scripts/check-followup-curve.ts`.
 *
 * Two things here are easy to get wrong and hard to notice in production. First,
 * the curve must TERMINATE — a bug that returns a deadline forever turns Lucy
 * into a weekly nag and gets her muted, which costs the flight alerts too.
 * Second, the deadlines are offsets from whatever time the reminder happened to
 * fire, so without the waking-hours clamp a 10pm reminder nudges at 10pm three
 * times. Case 3 is that scenario. Pure arithmetic — touches no network.
 */
import { MAX_FOLLOW_UPS, nextFollowUpAt, ownerTimezone } from "#lib/reminders.js";

const tz = ownerTimezone();
const local = (iso: string) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
  }).format(new Date(iso));
const hourIn = (iso: string) =>
  Number(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hour12: false })
      .format(new Date(iso))
      .replace("24", "0"),
  );
const minuteIn = (iso: string) =>
  Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, minute: "2-digit" }).format(new Date(iso)));
/** The send window is 8:00am–9:00pm owner-local, inclusive of both endpoints. */
const sendable = (iso: string) => {
  const h = hourIn(iso);
  return h >= 8 && (h < 21 || (h === 21 && minuteIn(iso) === 0));
};

let failures = 0;
function check(name: string, ok: boolean, note = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? ` — ${note}` : ""}`);
}

/** Walk the whole curve from a fire time, as reminder-poll does. */
function walk(sentAt: string): string[] {
  const out: string[] = [];
  for (let count = 0; count < 10; count++) {
    const next = nextFollowUpAt(sentAt, count);
    if (!next) break;
    out.push(next);
  }
  return out;
}

// 1. A midday reminder: three nudges at roughly +1d, +3d, +7d, no clamping needed.
const noon = walk("2026-08-03T16:00:00.000Z"); // 12pm ET
console.log(`\n1. fired ${local("2026-08-03T16:00:00.000Z")} →`);
noon.forEach((n, i) => console.log(`     nudge ${i + 1}: ${local(n)}`));
check("midday: exactly 3 nudges", noon.length === 3, `got ${noon.length}`);
const days = noon.map((n) => (new Date(n).getTime() - Date.parse("2026-08-03T16:00:00.000Z")) / 86400_000);
check("midday: spacing is 1d / 3d / 7d", JSON.stringify(days) === JSON.stringify([1, 3, 7]), days.join(", "));

// 2. The curve terminates. This is the whole point of the redesign: the old
//    boolean meant one nudge then silence forever; unbounded is the opposite bug.
check("curve terminates", nextFollowUpAt("2026-08-03T16:00:00.000Z", MAX_FOLLOW_UPS) === null);
check("MAX_FOLLOW_UPS matches the walk", noon.length === MAX_FOLLOW_UPS, `${noon.length} vs ${MAX_FOLLOW_UPS}`);

// 3. A 10pm reminder. Unclamped, every nudge lands at 10pm; each must move to
//    the nearer edge of the send window, which here is the 9pm just behind it.
const late = walk("2026-08-04T02:00:00.000Z"); // 10pm ET Aug 3
console.log(`\n3. fired ${local("2026-08-04T02:00:00.000Z")} →`);
late.forEach((n, i) => console.log(`     nudge ${i + 1}: ${local(n)}`));
check("late-night: all nudges in the send window", late.every(sendable),
  late.map(hourIn).join(", "));
// The clamp must not distort the 24/72/168 curve much. Always-pushing-forward
// would make nudge 1 land 34h out instead of ~24h; nearest-edge holds every
// deadline to within half the quiet window (5.5h) of where it nominally falls.
check("late-night: within 6h of the nominal curve",
  late.every((n, i) =>
    Math.abs(new Date(n).getTime() - (Date.parse("2026-08-04T02:00:00.000Z") + [24, 72, 168][i] * 3600_000))
      <= 6 * 3600_000),
  late.map((n, i) =>
    `${((new Date(n).getTime() - Date.parse("2026-08-04T02:00:00.000Z")) / 3600_000 - [24, 72, 168][i]).toFixed(1)}h`,
  ).join(", "));

// 3b. A 3am reminder — past the 2:30am midpoint of the quiet window, so the
//     nearer edge is the 8am ahead and the deadline moves forward.
const small = walk("2026-08-03T07:00:00.000Z"); // 3am ET
console.log(`\n3b. fired ${local("2026-08-03T07:00:00.000Z")} →`);
small.forEach((n, i) => console.log(`     nudge ${i + 1}: ${local(n)}`));
check("small-hours: all nudges in the send window", small.every(sendable),
  small.map(hourIn).join(", "));
check("small-hours: within 6h of the nominal curve",
  small.every((n, i) =>
    Math.abs(new Date(n).getTime() - (Date.parse("2026-08-03T07:00:00.000Z") + [24, 72, 168][i] * 3600_000))
      <= 6 * 3600_000));

// 3d. A 2am reminder — BEFORE the 2:30am midpoint, so unlike 3b the nearer edge
//     is the 9pm behind it and the deadline moves backward across midnight into
//     the previous evening. This is the one case that walks the day counter
//     back a day, and the only branch the 9am→8am window change re-sorted.
const preDawn = walk("2026-08-03T06:00:00.000Z"); // 2am ET
console.log(`\n3d. fired ${local("2026-08-03T06:00:00.000Z")} →`);
preDawn.forEach((n, i) => console.log(`     nudge ${i + 1}: ${local(n)}`));
check("pre-dawn: all nudges in the send window", preDawn.every(sendable),
  preDawn.map(hourIn).join(", "));
check("pre-dawn: snapped backward to the previous evening",
  preDawn.every((n) => hourIn(n) === 21));
check("pre-dawn: within 6h of the nominal curve",
  preDawn.every((n, i) =>
    Math.abs(new Date(n).getTime() - (Date.parse("2026-08-03T06:00:00.000Z") + [24, 72, 168][i] * 3600_000))
      <= 6 * 3600_000));

// 3c. Nudges must stay strictly ordered and in the future no matter how the
//     clamp moves them — the 48h/96h gaps give it 6h of slack to work in.
for (const [label, curve, from] of [
  ["midday", noon, "2026-08-03T16:00:00.000Z"],
  ["late-night", late, "2026-08-04T02:00:00.000Z"],
  ["small-hours", small, "2026-08-03T07:00:00.000Z"],
  ["pre-dawn", preDawn, "2026-08-03T06:00:00.000Z"],
] as const) {
  check(`${label}: strictly increasing and after the fire time`,
    curve.every((n, i) =>
      new Date(n).getTime() > Date.parse(from) &&
      (i === 0 || new Date(n).getTime() > new Date(curve[i - 1]).getTime())));
}

// 4. A 6am reminder clamps forward to the same morning, not the next day.
const early = walk("2026-08-03T10:00:00.000Z"); // 6am ET
console.log(`\n4. fired ${local("2026-08-03T10:00:00.000Z")} →`);
early.forEach((n, i) => console.log(`     nudge ${i + 1}: ${local(n)}`));
check("early-morning: all nudges in the send window", early.every(sendable),
  early.map(hourIn).join(", "));
check("early-morning: first nudge is same-day 8am, not next-day",
  new Date(early[0]).getTime() - Date.parse("2026-08-03T10:00:00.000Z") < 30 * 3600_000,
  local(early[0]));

// 5. Deadlines are a pure function of (sent_at, count) — that is what lets the
//    poll recompute the value it nulled out as its claim when a dispatch fails.
check("recompute is stable", nextFollowUpAt("2026-08-03T16:00:00.000Z", 1) === nextFollowUpAt("2026-08-03T16:00:00.000Z", 1));

// 6. Crossing the fall-back DST boundary (Nov 1 2026, 2am ET). The +7d nudge
//    lands on the other side of the change; it must still be a waking hour.
const dst = walk("2026-10-28T21:00:00.000Z"); // 5pm ET Oct 28
console.log(`\n6. fired ${local("2026-10-28T21:00:00.000Z")} (spans the DST change) →`);
dst.forEach((n, i) => console.log(`     nudge ${i + 1}: ${local(n)}`));
check("dst: all nudges in the send window", dst.every(sendable),
  dst.map(hourIn).join(", "));

console.log(`\n${failures === 0 ? "All checks passed." : `${failures} FAILURE(S).`}`);
process.exit(failures === 0 ? 0 : 1);
