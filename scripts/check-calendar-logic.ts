/**
 * Checks the pure logic behind calendar guests.
 * Run with `npx tsx scripts/check-calendar-logic.ts`.
 *
 * None of this touches the network, but all of it decides what lands in
 * somebody else's inbox. Three failure modes are worth more than the rest:
 *
 *  - mergeAttendees losing existing guests. Google's PATCH REPLACES the
 *    attendees array rather than merging, so "add one guest" that forgets to
 *    read-modify-write silently uninvites everyone already on the event, and
 *    Google mails them all a cancellation to prove it.
 *  - normalizeAttendees letting the owner's own address through. He's the
 *    organizer; listing him again makes him an invitee of his own dinner.
 *  - shiftedEnd not preserving duration. "Push it to 8" on a three-hour dinner
 *    must not quietly become a one-hour dinner — including across a DST
 *    boundary, where wall-clock arithmetic and elapsed time disagree.
 */
import {
  hasGuests,
  mergeAttendees,
  normalizeAttendees,
  shiftedEnd,
  type GcalAttendee,
} from "#lib/calendar.js";
import { ownerWallClockToUtc } from "#lib/reminders.js";

process.env.OWNER_EMAIL = "owner@example.com";
process.env.OWNER_TIMEZONE = "America/New_York";

let failures = 0;
function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    failures++;
    console.log(
      `FAIL  ${name}\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`,
    );
  } else {
    console.log(`PASS  ${name}`);
  }
}

const emails = (list: GcalAttendee[]): (string | undefined)[] => list.map((a) => a.email);

// --- normalizeAttendees -----------------------------------------------------

check("normalize: undefined is an empty list", normalizeAttendees(undefined), []);
check("normalize: empty stays empty", normalizeAttendees([]), []);
check("normalize: trims and lowercases", normalizeAttendees(["  Sarah@Example.COM "]), [
  "sarah@example.com",
]);
check(
  "normalize: dedupes case-variant repeats",
  normalizeAttendees(["sarah@example.com", "SARAH@example.com"]),
  ["sarah@example.com"],
);
check(
  "normalize: drops the owner, he's the organizer",
  normalizeAttendees(["Owner@Example.com", "sarah@example.com"]),
  ["sarah@example.com"],
);
check(
  "normalize: owner-only list invites nobody",
  normalizeAttendees(["owner@example.com"]),
  [],
);
check("normalize: skips blanks", normalizeAttendees(["", "   ", "sarah@example.com"]), [
  "sarah@example.com",
]);
check(
  "normalize: preserves order of first appearance",
  normalizeAttendees(["b@x.com", "a@x.com", "b@x.com"]),
  ["b@x.com", "a@x.com"],
);

// --- mergeAttendees ---------------------------------------------------------

const existing: GcalAttendee[] = [
  { email: "sarah@example.com", responseStatus: "accepted" },
  { email: "owner@example.com", responseStatus: "accepted", self: true, organizer: true },
];

check(
  "merge: adding a guest keeps the existing ones",
  emails(mergeAttendees(existing, ["mike@example.com"], undefined)),
  ["sarah@example.com", "owner@example.com", "mike@example.com"],
);
check(
  "merge: adding preserves the existing RSVP objects untouched",
  mergeAttendees(existing, ["mike@example.com"], undefined)[0],
  { email: "sarah@example.com", responseStatus: "accepted" },
);
check(
  "merge: removing drops just that guest",
  emails(mergeAttendees(existing, undefined, ["sarah@example.com"])),
  ["owner@example.com"],
);
check(
  "merge: remove is case-insensitive",
  emails(mergeAttendees(existing, undefined, ["SARAH@Example.com"])),
  ["owner@example.com"],
);
check(
  "merge: removing someone not on the event is a no-op",
  emails(mergeAttendees(existing, undefined, ["nobody@example.com"])),
  ["sarah@example.com", "owner@example.com"],
);
check(
  "merge: re-adding an existing guest doesn't duplicate them",
  emails(mergeAttendees(existing, ["Sarah@example.com"], undefined)),
  ["sarah@example.com", "owner@example.com"],
);
check(
  "merge: add and remove in one call",
  emails(mergeAttendees(existing, ["mike@example.com"], ["sarah@example.com"])),
  ["owner@example.com", "mike@example.com"],
);
check(
  "merge: the owner can't be added as his own guest",
  emails(mergeAttendees([], ["owner@example.com"], undefined)),
  [],
);
check("merge: no existing attendees, nothing to add", mergeAttendees(undefined, [], []), []);

// --- hasGuests --------------------------------------------------------------

check("hasGuests: bare event is solo", hasGuests({}), false);
check("hasGuests: empty attendees is solo", hasGuests({ attendees: [] }), false);
check(
  "hasGuests: the owner alone is still solo — no mail should go out",
  hasGuests({ attendees: [{ email: "owner@example.com", self: true }] }),
  false,
);
check(
  "hasGuests: a real guest means a real email",
  hasGuests({ attendees: [{ email: "owner@example.com", self: true }, { email: "s@x.com" }] }),
  true,
);

// --- shiftedEnd -------------------------------------------------------------

const at = (wall: string): Date => {
  const d = ownerWallClockToUtc(wall);
  if (!d) throw new Error(`bad wall-clock in test: ${wall}`);
  return d;
};

const threeHourStart = at("2026-08-07T19:00").toISOString();
const threeHourEnd = at("2026-08-07T22:00").toISOString();
check(
  "shiftedEnd: a 3h dinner moved to 8pm still runs 3h",
  shiftedEnd(threeHourStart, threeHourEnd, at("2026-08-07T20:00"))?.toISOString(),
  at("2026-08-07T23:00").toISOString(),
);
check(
  "shiftedEnd: moving to another day keeps the duration",
  shiftedEnd(threeHourStart, threeHourEnd, at("2026-08-09T12:00"))?.toISOString(),
  at("2026-08-09T15:00").toISOString(),
);

// DST fall-back is Nov 1 2026 in New York. A 2h event moved onto that morning
// must stay 2 elapsed hours (01:00 -> 03:00 by the clock), not 2 clock hours.
const twoHourStart = at("2026-10-15T09:00").toISOString();
const twoHourEnd = at("2026-10-15T11:00").toISOString();
const movedIntoFallBack = shiftedEnd(twoHourStart, twoHourEnd, at("2026-11-01T01:00"));
check(
  "shiftedEnd: 2h across the DST fall-back stays 2 elapsed hours",
  (movedIntoFallBack!.getTime() - at("2026-11-01T01:00").getTime()) / 3600000,
  2,
);

check(
  "shiftedEnd: all-day event has no duration to keep",
  shiftedEnd(undefined, undefined, at("2026-08-07T20:00")),
  null,
);
check(
  "shiftedEnd: missing end is unusable",
  shiftedEnd(threeHourStart, undefined, at("2026-08-07T20:00")),
  null,
);
check(
  "shiftedEnd: a zero-length range is unusable",
  shiftedEnd(threeHourStart, threeHourStart, at("2026-08-07T20:00")),
  null,
);
check(
  "shiftedEnd: unparseable timestamps are unusable",
  shiftedEnd("not-a-date", threeHourEnd, at("2026-08-07T20:00")),
  null,
);

// --- the create-side approval predicate -------------------------------------
// Mirrors create_calendar_event's `approval`. The point of the gate is that a
// solo event must NOT prompt — if this ever returns "user-approval" for an
// empty guest list, every reminder-shaped event starts nagging for approval.

const createApproval = (attendees?: string[]) =>
  (attendees?.length ?? 0) > 0 ? "user-approval" : "not-applicable";

check("approval: no guests, no prompt", createApproval(undefined), "not-applicable");
check("approval: empty guest list, no prompt", createApproval([]), "not-applicable");
check("approval: one guest prompts", createApproval(["sarah@example.com"]), "user-approval");

console.log(failures === 0 ? "\nAll calendar checks passed." : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
