/**
 * Shows what a snipe with a fallback party size WOULD book, without booking it.
 *
 *   npx tsx --env-file=.env.local scripts/check-resy-fallback.ts <venueId> <date> <primary> <fallback> [hh:mm-hh:mm]
 *   npx tsx --env-file=.env.local scripts/check-resy-fallback.ts 85214 2026-09-08 4 2 11:00-17:00
 *
 * The fallback is the one bound on a snipe that can book a table seating fewer
 * people than he asked for, so "which size would this have taken, and why" is
 * worth being able to answer against real inventory rather than by reading the
 * loop. It asks the sizes in the same order the race does — `authorizedPartySizes`
 * is imported, not reimplemented, so this cannot drift from what actually fires.
 *
 * Read-only: it resolves slots and ranks them, and stops before /3/details.
 *
 * One thing it does NOT model: at a real drop the race holds a fallback table
 * for ~1s (FALLBACK_GRACE_POLLS) while it keeps asking for the primary size, so
 * a four-top publishing a beat after the two-tops still wins. That only delays
 * the fallback, never changes which size is preferred, so the answer below is
 * still the one that gets booked.
 */
import { authorizedPartySizes, findSlots, formatTime, rankSlots } from "#lib/resy.js";
import { ensureResyStore } from "#lib/resy-store.js";

const venueId = Number(process.argv[2]);
const day = process.argv[3];
const primary = Number(process.argv[4]);
const fallback = process.argv[5] ? Number(process.argv[5]) : null;
const [earliest, latest] = (process.argv[6] ?? "00:00-23:59").split("-");

if (!venueId || !/^\d{4}-\d{2}-\d{2}$/.test(day ?? "") || !primary) {
  console.error("usage: check-resy-fallback.ts <venueId> <YYYY-MM-DD> <primary> [fallback] [hh:mm-hh:mm]");
  process.exit(1);
}

ensureResyStore();

const prefs = { earliestTime: earliest, latestTime: latest, preferredTime: null, slotTypes: null };
const sizes = authorizedPartySizes({ party_size: primary, fallback_party_size: fallback });

console.log(`Venue ${venueId} on ${day}, window ${formatTime(earliest)}–${formatTime(latest)}`);
console.log(`Sizes in race order: ${sizes.join(" then ")}\n`);

let decided = false;
for (const size of sizes) {
  const slots = await findSlots({ venueId, day, partySize: size });
  const ranked = rankSlots(slots, prefs);
  const inventory = slots.length
    ? slots.map((s) => `${formatTime(s.time)} ${s.type ?? ""}`.trim()).join(", ")
    : "nothing";
  console.log(`party ${size}: ${slots.length} slot(s) — ${inventory}`);
  console.log(`           ${ranked.length} inside the window`);

  if (!decided && ranked.length > 0) {
    decided = true;
    const pick = ranked[0];
    const label = size === primary ? "the size he asked for" : `the ${size}-person FALLBACK`;
    console.log(`\n→ WOULD BOOK party ${size} (${label}): ${formatTime(pick.time)} ${pick.type ?? ""}`);
    // Deliberately keeps looking, so the output also shows what it passed over.
  }
}

if (!decided) console.log("\n→ WOULD BOOK nothing — no size had a table inside the window.");
