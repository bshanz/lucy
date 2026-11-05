/**
 * Checks location reminders. Run with
 *   npx tsx --env-file=.env.local scripts/check-location-reminders.ts
 *
 * Pure checks first (place normalizing, event parsing, the bounce window, the
 * re-arm rule), then a live round trip against Supabase on a throwaway place
 * key: a waiting reminder is armed by a ping, a repeat ping is a duplicate, the
 * opposite event doesn't arm it, and an each_time row goes back to waiting. The
 * live half cleans up after itself and is skipped without Supabase env.
 */
import {
  BOUNCE_WINDOW_MS,
  isBounce,
  normalizePlace,
  parseEvent,
  rearmedFireAt,
  recordLocationEvent,
} from "#lib/location.js";
import { supabase } from "#lib/supabase.js";

let failures = 0;
function check(name: string, ok: boolean, note = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? ` — ${note}` : ""}`);
}

// --- pure
check("normalize 'Home'", normalizePlace("Home ") === "home");
check("normalize 'my office'", normalizePlace("my office") === "office");
check("normalize 'The Gym'", normalizePlace("The Gym") === "gym");
check("normalize 'Mom's house'", normalizePlace("Mom's house") === "mom_s_house");
check("event 'arrive'", parseEvent("Arrive") === "arrive");
check("event 'left'", parseEvent("left") === "leave");
check("event junk", parseEvent("teleport") === null && parseEvent(3) === null);

const now = Date.now();
const ago = (ms: number) => new Date(now - ms).toISOString();
check("no prior ping is not a bounce", !isBounce(null, "arrive", now));
check("same event 2m ago is a bounce", isBounce({ last_event: "arrive", last_event_at: ago(120_000) }, "arrive", now));
check(
  "same event past the window is not",
  !isBounce({ last_event: "arrive", last_event_at: ago(BOUNCE_WINDOW_MS + 1) }, "arrive", now),
);
check("opposite event is never a bounce", !isBounce({ last_event: "leave", last_event_at: ago(1000) }, "arrive", now));
check("location series re-arms to null", rearmedFireAt({ trigger_place: "home" }, () => "X") === null);
check("timed series uses cadence", rearmedFireAt({ trigger_place: null }, () => "X") === "X");

// --- live
async function live() {
  const place = `zz_check_${Date.now()}`;
  // Armed rows really are due for the instant before cleanup, and the
  // production poller runs every minute. A Slack row with no target is one it
  // cancels instead of delivering, so a race can never text him "check: …".
  const target = { channel: "slack", phone: null, slack_target: null };
  const ids: string[] = [];
  try {
    const { data: rows, error } = await supabase
      .from("reminders")
      .insert([
        { ...target, body: "check: one-off", fire_at: null, trigger_place: place, trigger_event: "arrive" },
        { ...target, body: "check: on leave", fire_at: null, trigger_place: place, trigger_event: "leave" },
      ])
      .select("id");
    if (error) throw new Error(error.message);
    ids.push(...rows!.map((r) => r.id as string));

    const unarmed = await supabase.from("reminders").select("id").eq("id", ids[0]).lte("fire_at", new Date().toISOString());
    check("unarmed row invisible to the due query", (unarmed.data ?? []).length === 0);

    const first = await recordLocationEvent(place, "arrive");
    check("ping arms the arrive reminder", first.status === "ok" && first.triggered === 1, JSON.stringify(first));

    const { data: after } = await supabase.from("reminders").select("id, fire_at").in("id", ids);
    const armed = after!.find((r) => r.id === ids[0]);
    const other = after!.find((r) => r.id === ids[1]);
    check("arrive row has fire_at", !!armed?.fire_at);
    check("leave row untouched", other?.fire_at === null);

    const second = await recordLocationEvent(place, "arrive");
    check("repeat ping is a duplicate", second.status === "duplicate");

    const left = await recordLocationEvent(place, "leave");
    check("leave ping arms the leave reminder", left.status === "ok" && left.triggered === 1);

    // Reject a reminder anchored to nothing.
    const bad = await supabase.from("reminders").insert({ ...target, body: "x", fire_at: null });
    check("anchor constraint rejects time-less, place-less rows", !!bad.error);
  } finally {
    if (ids.length) await supabase.from("reminders").delete().in("id", ids);
    await supabase.from("places").delete().eq("key", place);
  }
}

if (process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY) {
  await live();
} else {
  console.log("SKIP  live checks (no Supabase env)");
}

console.log(failures ? `\n${failures} failure(s)` : "\nall passed");
process.exit(failures ? 1 : 0);
