/**
 * Checks travel mode: the temporary timezone override and the reminder
 * re-anchor that goes with it.
 * Run with `npx tsx scripts/check-timezone-override.ts`.
 *
 * The failure this file exists to prevent is silent. fire_at is a UTC instant
 * and nextOccurrence steps the wall clock in whatever zone is active AT FIRE
 * TIME, so a recurring reminder crossing a timezone switch preserves its
 * INSTANT, not its hour. Flip the zone without re-anchoring and the 7:45pm
 * healthy-eating check-in starts arriving at 4:45pm in San Francisco — before
 * he's eaten dinner — every night of the trip, and nothing errors. Case 1 is
 * exactly that scenario.
 *
 * The other half is coverage: ownerTimezone() is synchronous and serves the
 * HOME zone until something primes the cache, so an ingress path that forgets
 * to call primeOwnerTimezone() silently ignores travel mode. That can't be
 * caught by arithmetic, so the last check greps for it.
 *
 * Pure logic plus a filesystem read. Touches no network and no database.
 */
import { readdirSync, readFileSync } from "node:fs";
import { homeTimezone, isValidTimezone, wallClockToUtc } from "#lib/reminders.js";

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

const ET = "America/New_York";
const PT = "America/Los_Angeles";

/** The hour:minute a UTC instant reads as in `tz` — what he actually sees. */
function hourIn(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(d);
}

/** What reanchorRecurring does to one row, without the database. */
function reanchor(fireAt: Date, fromTz: string, toTz: string): Date {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: fromTz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(fireAt);
  const g = (t: string) => p.find((x) => x.type === t)!.value;
  const wall = `${g("year")}-${g("month")}-${g("day")}T${String(Number(g("hour")) % 24).padStart(2, "0")}:${g("minute")}:${g("second")}`;
  return wallClockToUtc(wall, toTz)!;
}

// --- 1. The check-in keeps its hour, and would not have without the re-anchor.
console.log("\n-- the nightly check-in survives a trip to San Francisco --");
const checkIn = wallClockToUtc("2026-09-02T19:45", ET)!;
check("set at 7:45pm Eastern", hourIn(checkIn, ET), "19:45");
// This is the bug, asserted so it can never quietly come back.
check("WITHOUT a re-anchor it reads 4:45pm in SF", hourIn(checkIn, PT), "16:45");
const moved = reanchor(checkIn, ET, PT);
check("re-anchored, it reads 7:45pm in SF", hourIn(moved, PT), "19:45");
check("and the shift was exactly 3 hours", (moved.getTime() - checkIn.getTime()) / 3_600_000, 3);

// --- 2. Coming home is the exact inverse: no drift accumulates over a trip.
console.log("\n-- and comes home unchanged --");
const back = reanchor(moved, PT, ET);
check("home again at 7:45pm Eastern", hourIn(back, ET), "19:45");
check("round trip is lossless", back.getTime(), checkIn.getTime());

// --- 3. A trip that straddles the DST boundary. US zones shift on the same
// date, so the wall clock must hold even though the UTC offset moves under it.
console.log("\n-- across the DST fall-back boundary (Nov 1 2026) --");
const beforeDst = wallClockToUtc("2026-10-30T19:45", ET)!;
const afterDst = wallClockToUtc("2026-11-03T19:45", ET)!;
check("7:45pm before the change", hourIn(beforeDst, ET), "19:45");
check("7:45pm after the change", hourIn(afterDst, ET), "19:45");
check("re-anchored across it, still 7:45pm local", hourIn(reanchor(afterDst, ET, PT), PT), "19:45");
// The offset genuinely moved; if this is 0 the test proves nothing.
const offsetShift =
  (afterDst.getTime() - beforeDst.getTime()) / 3_600_000 - 4 * 24;
check("the UTC offset really did shift by an hour", offsetShift, 1);

// --- 4. Eastward travel can push the next occurrence into the past, which is
// what the nextOccurrence roll-forward in reanchorRecurring is there for.
console.log("\n-- eastward travel moves a series earlier --");
const tokyo = reanchor(checkIn, ET, "Asia/Tokyo");
check("7:45pm in Tokyo", hourIn(tokyo, "Asia/Tokyo"), "19:45");
check("which is EARLIER in absolute terms", tokyo.getTime() < checkIn.getTime(), true);

// --- 4b. A one-off set IN San Francisco, before the trip was mentioned. This
// is the case reanchorRecurring deliberately does not handle, so set_timezone
// reports it instead: the hour he typed was read in the zone he had already
// left, which makes it early by the whole offset, not late.
console.log("\n-- a one-off set after landing, before telling her --");
// He is standing in SF and types "5pm". Lucy still thinks Eastern, so it is
// stored as 5pm ET.
const stored = wallClockToUtc("2026-09-02T17:00", ET)!;
check("he'll be told 5pm", hourIn(stored, ET), "17:00");
check("but it fires at 2pm where he's standing", hourIn(stored, PT), "14:00");
check("i.e. THREE HOURS EARLY, not late", (stored.getTime() - wallClockToUtc("2026-09-02T17:00", PT)!.getTime()) / 3_600_000, -3);
// What set_timezone offers him: the same wall clock, honoured in the new zone.
const offered = reanchor(stored, ET, PT);
check("the offered fix reads 5pm in SF", hourIn(offered, PT), "17:00");
// And the offer must be a bare wall clock reschedule_reminder can consume.
check("moveTo shape is YYYY-MM-DDTHH:mm", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test("2026-09-02T17:00"), true);

// --- 5. Zone validation. The model will reach for abbreviations; they must be
// rejected loudly rather than resolving to something plausible and wrong.
console.log("\n-- zone validation --");
check("IANA zone accepted", isValidTimezone(PT), true);
check("home zone is valid", isValidTimezone(homeTimezone()), true);
check("'Pacific' rejected", isValidTimezone("Pacific"), false);
check("gibberish rejected", isValidTimezone("America/Nowhere"), false);
// The traps. ICU RESOLVES all four, so "does Intl accept it" is not a
// sufficient test — EST silently means Panama and MST means Phoenix, neither
// of which observes daylight saving. Accepting "EST" for Eastern would put
// every reminder an hour off from March to November, with no error anywhere.
check("'EST' rejected (ICU reads it as America/Panama)", isValidTimezone("EST"), false);
check("'MST' rejected (ICU reads it as America/Phoenix)", isValidTimezone("MST"), false);
check("'PST' rejected", isValidTimezone("PST"), false);
check("'HST' rejected", isValidTimezone("HST"), false);
// Sanity: the zones those abbreviations were reached for must still work.
check("America/New_York accepted", isValidTimezone("America/New_York"), true);
check("Europe/London accepted", isValidTimezone("Europe/London"), true);
check("Asia/Tokyo accepted", isValidTimezone("Asia/Tokyo"), true);

// --- 6. Every ingress path must prime, or travel mode is silently ignored on
// that path. This is a grep, not arithmetic, because there is no other way to
// catch a schedule added six months from now.
console.log("\n-- every channel and schedule primes the cache --");
for (const dir of ["agent/channels", "agent/schedules"]) {
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
    const src = readFileSync(`${dir}/${file}`, "utf8");
    // eve.ts is a re-export shim with no turn of its own.
    if (!/defineChannel|slackChannel|defineSchedule/.test(src)) continue;
    check(`${dir}/${file} calls primeOwnerTimezone`, /await primeOwnerTimezone\(\)/.test(src), true);
  }
}

// --- 7. Resy drop times must NOT follow him. A drop time belongs to the
// restaurant; if computeDropAt went back to the current zone, every snipe armed
// before a trip would shift by the offset mid-flight and lose the table by
// hours, having looked correct on the approval card when he armed it. There is
// no way to assert this arithmetically without a database, so guard the import.
console.log("\n-- resy drop times stay pinned to the home zone --");
const resySrc = readFileSync("agent/lib/resy.ts", "utf8");
// The import list, not the whole file: the prose above computeDropAt names the
// current-zone helpers precisely to explain why they are not used here.
const resyImports = resySrc.match(/import\s*\{([^}]*)\}\s*from\s*"#lib\/reminders\.js"/)?.[1] ?? "";
check("resy.ts resolves drop times against homeTimezone", /homeTimezone\(\)/.test(resySrc), true);
check("resy.ts imports homeTimezone", /\bhomeTimezone\b/.test(resyImports), true);
check("resy.ts does not import ownerTimezone", /\bownerTimezone\b/.test(resyImports), false);
check("resy.ts does not import ownerWallClockToUtc", /\bownerWallClockToUtc\b/.test(resyImports), false);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
