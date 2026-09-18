/**
 * Pins the iMessage approval cards. Pure, no network:
 * `npx tsx scripts/check-approval-card.ts`
 *
 * Before these, a gated call went out as eve's "Approve tool call: X" plus a
 * raw `key: value` dump of the input (`startLocal: 2026-09-28T08:20`,
 * `attendees: ["..."]`). Each card here is what the owner reads instead.
 * Times are rendered exactly as passed — they are owner-local wall clock by
 * contract — so a change that starts applying a zone here would show up as a
 * shifted hour below.
 */
import { formatApprovalCard, formatOptions, formatWallRange, humanize } from "#lib/approval-card.js";

let failures = 0;
function check(name: string, actual: string[], expected: string[]) {
  const ok = actual.join("\n") === expected.join("\n");
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) console.log(`  expected:\n${expected.map((l) => `    ${l}`).join("\n")}\n  actual:\n${actual.map((l) => `    ${l}`).join("\n")}`);
}
function checkEq(name: string, actual: string, expected: string) {
  check(name, [actual], [expected]);
}

check(
  "calendar event with guests (the Quest card)",
  formatApprovalCard("create_calendar_event", {
    title: "Lab Visit at Quest Diagnostics",
    startLocal: "2026-09-28T08:20",
    endLocal: "2026-09-28T08:40",
    description: "Confirmation Code: RBKOFL. May need to avoid seafood or skip workout beforehand.",
    location: "261 Old Hook Rd, Westwood, NJ 07675",
    attendees: ["brittanyberg93@gmail.com"],
  }),
  [
    "📅 **Add to calendar?**",
    "**Lab Visit at Quest Diagnostics**",
    "Mon, Sep 28 · 8:20–8:40 AM",
    "📍 261 Old Hook Rd, Westwood, NJ 07675",
    "👥 brittanyberg93@gmail.com",
    "",
    "Confirmation Code: RBKOFL. May need to avoid seafood or skip workout beforehand.",
  ],
);

check(
  "calendar event, start only, no extras",
  formatApprovalCard("create_calendar_event", { title: "Coffee", startLocal: "2026-10-02T15:00", attendees: ["a@b.co"] }),
  ["📅 **Add to calendar?**", "**Coffee**", "Fri, Oct 2 · 3:00 PM", "👥 a@b.co"],
);

checkEq("range across noon shows both meridiems", formatWallRange("2026-09-28T11:30", "2026-09-28T12:15"), "Mon, Sep 28 · 11:30 AM–12:15 PM");
checkEq("range across days repeats the date", formatWallRange("2026-09-28T22:00", "2026-09-29T01:00"), "Mon, Sep 28 · 10:00 PM – Tue, Sep 29 · 1:00 AM");
checkEq("unparseable wall clock passes through", formatWallRange("whenever", undefined), "whenever");

check(
  "calendar update: move + invite",
  formatApprovalCard("update_calendar_event", {
    eventId: "abc123",
    startLocal: "2026-09-29T09:00",
    endLocal: "2026-09-29T09:30",
    addAttendees: ["x@y.com"],
    removeAttendees: ["old@y.com"],
  }),
  ["📅 **Update this event?**", "When → Tue, Sep 29 · 9:00–9:30 AM", "➕ Invite x@y.com", "➖ Uninvite old@y.com", "Event abc123"],
);

check(
  "send email shows the whole body under a blank line",
  formatApprovalCard("send_email", { to: "bob@example.com", subject: "Lunch", body: "Hey Bob,\n\nThursday?" }),
  ["✉️ **Send this email?**", "To: bob@example.com", "Subject: Lunch", "", "Hey Bob,", "", "Thursday?"],
);

check(
  "scheduled email carries the send time",
  formatApprovalCard("schedule_email", { to: "bob@example.com", subject: "Lunch", body: "Hi", sendAtLocal: "2026-09-19T09:00" }),
  ["✉️ **Schedule this email?**", "To: bob@example.com", "Subject: Lunch", "Sends: Sat, Sep 19 · 9:00 AM", "", "Hi"],
);

check(
  "reply keeps the thread id at the bottom",
  formatApprovalCard("reply_to_email", { threadId: "t1", body: "Sounds good." }),
  ["✉️ **Send this reply?**", "", "Sounds good.", "", "Thread t1"],
);

check(
  "book resy with no deposit",
  formatApprovalCard("book_resy", { configToken: "opaque", date: "2026-10-24", partySize: 2 }),
  ["🍽️ **Book this table?**", "Sat, Oct 24 · party of 2", "Deposit: none — card-required tables are skipped"],
);

check(
  "snipe with a fixed drop time",
  formatApprovalCard("snipe_resy", {
    venueId: 1,
    venueName: "Carbone",
    reservationDate: "2026-10-24",
    partySize: 4,
    fallbackPartySize: 2,
    earliestTime: "19:00",
    latestTime: "21:00",
    preferredTime: "20:00",
    slotTypes: ["Dining Room", "Bar"],
    maxDepositCents: 5000,
    dropAtLocal: "2026-09-24T09:00",
  }),
  [
    "🎯 **Arm this snipe?**",
    "**Carbone** · Sat, Oct 24 · party of 4 (or 2 if that's all there is)",
    "Seating: 7:00–9:00 PM, ideally 8:00 PM",
    "Tables: Dining Room, then Bar",
    "Deposit: up to $50",
    "Books at: Thu, Sep 24 · 9:00 AM",
  ],
);

check(
  "snipe with a watch window and a likely moment",
  formatApprovalCard("snipe_resy", {
    venueId: 1,
    venueName: "Via Carota",
    reservationDate: "2026-10-24",
    partySize: 2,
    earliestTime: "18:30",
    latestTime: "20:30",
    maxDepositCents: 2550,
    watchFromLocal: "2026-09-24T09:00",
    watchUntilLocal: "2026-09-24T12:00",
    expectedDropLocal: "2026-09-24T10:00",
  }),
  [
    "🎯 **Arm this snipe?**",
    "**Via Carota** · Sat, Oct 24 · party of 2",
    "Seating: 6:30–8:30 PM",
    "Deposit: up to $25.50",
    "Watching: Thu, Sep 24 · 9:00 AM–12:00 PM (likely around 10:00 AM)",
  ],
);

check(
  "snipe with days-ahead rule",
  formatApprovalCard("snipe_resy", { venueId: 1, venueName: "Don Angie", reservationDate: "2026-11-01", partySize: 2, earliestTime: "19:00", latestTime: "21:00", daysAhead: 30, dropTimeLocal: "09:00" }),
  ["🎯 **Arm this snipe?**", "**Don Angie** · Sun, Nov 1 · party of 2", "Seating: 7:00–9:00 PM", "Deposit: none — card-required tables are skipped", "Books: 30 days out at 9:00 AM"],
);

check(
  "cancel resy",
  formatApprovalCard("cancel_resy_booking", { resyToken: "rgs://abc" }),
  ["🍽️ **Cancel this reservation?**", "Reservation rgs://abc"],
);

check(
  "unknown tool gets a tidied dump, never nothing",
  formatApprovalCard("run_thing", { maxDepositCents: 5, some_flag: true }),
  ["⚠️ **Approve run thing?**", "Max deposit cents: 5", "Some flag: true"],
);
checkEq("humanize camelCase", humanize("watchUntilLocal"), "Watch until local");

const long = "x".repeat(3100);
const clipped = formatApprovalCard("send_email", { to: "a@b.co", subject: "s", body: long }).at(-1)!;
check("email body is clipped only past 3000 chars, with a count", [clipped.slice(-23), String(clipped.length)], ["… (100 more characters)", String(3000 + 23)]);

check("two options collapse to one line", formatOptions([{ label: "Approve" }, { label: "Cancel" }], false), ["", "Reply 1 to Approve or 2 to Cancel."]);
check(
  "three options list out",
  formatOptions([{ label: "Approve" }, { label: "Stop" }, { label: "Later", description: "ask again tomorrow" }], true),
  ["", "1. Approve", "2. Stop", "3. Later — ask again tomorrow", "Reply with a number or option name.", "Or answer in your own words."],
);
check("no options, no footer", formatOptions([], true), []);

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
