import { supabase } from "#lib/supabase.js";

/**
 * Location triggers. The owner's phone runs iOS Shortcuts automations
 * ("When I Arrive Home" → POST /location/event) and this module turns a ping
 * into due reminders. See supabase/migrations/0013_location_reminders.sql for
 * why a location reminder is just a reminder whose fire_at is filled in late.
 */

export type LocationEvent = "arrive" | "leave";

export interface PlaceRow {
  key: string;
  label: string;
  last_event: LocationEvent | null;
  last_event_at: string | null;
  created_at: string;
}

/**
 * The recurrence value for "every time I get home". It is not a cadence, so
 * nextOccurrence must never see it — reminder-poll re-arms these by clearing
 * fire_at instead (see rearmedFireAt).
 */
export const EACH_TIME = "each_time";

/**
 * iOS geofences chatter at the edge: pulling into the driveway can fire Arrive
 * twice in a minute, and a weak GPS fix can fire Leave/Arrive in a pair. A
 * repeat of the SAME event inside this window is the same arrival.
 */
export const BOUNCE_WINDOW_MS = 10 * 60_000;

/**
 * One key per place no matter how it's typed — by the model ("Home", "the
 * gym") or in a Shortcut body ("home "). Leading articles and "my" go, since
 * "my office" and "office" are obviously the same automation.
 */
export function normalizePlace(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^(the|my)\s+/, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function parseEvent(raw: unknown): LocationEvent | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (v === "arrive" || v === "arrived" || v === "arrival") return "arrive";
  if (v === "leave" || v === "left" || v === "depart" || v === "departed") return "leave";
  return null;
}

/** Is this ping a repeat of the last one for the same place? */
export function isBounce(
  prev: Pick<PlaceRow, "last_event" | "last_event_at"> | null,
  event: LocationEvent,
  now: number,
): boolean {
  if (!prev?.last_event || !prev.last_event_at) return false;
  if (prev.last_event !== event) return false;
  return now - Date.parse(prev.last_event_at) < BOUNCE_WINDOW_MS;
}

/**
 * The fire_at a recurring reminder rolls to after it fires. A location series
 * goes back to waiting for the next arrival (null); a time series is handed to
 * the caller's cadence function.
 */
export function rearmedFireAt(
  reminder: { trigger_place: string | null },
  nextByCadence: () => string,
): string | null {
  return reminder.trigger_place ? null : nextByCadence();
}

/** "when he arrives home" / "when he leaves work" — for prompts and listings. */
export function describeTrigger(place: string, event: LocationEvent, person = "he"): string {
  const name = place.replace(/_/g, " ");
  return event === "arrive" ? `when ${person} arrives at ${name}` : `when ${person} leaves ${name}`;
}

export async function getPlace(key: string): Promise<PlaceRow | null> {
  const { data, error } = await supabase.from("places").select("*").eq("key", key).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as PlaceRow | null) ?? null;
}

export async function listPlaces(): Promise<PlaceRow[]> {
  const { data, error } = await supabase
    .from("places")
    .select("*")
    .order("last_event_at", { ascending: false, nullsFirst: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as PlaceRow[];
}

export type RecordResult =
  | { status: "duplicate"; place: string }
  | { status: "ok"; place: string; triggered: number };

/**
 * Record a ping and arm every reminder waiting on it. Deliberately does NOT
 * talk to the agent: arming is a single UPDATE, and reminder-poll (every
 * minute) owns delivery, confirmation and follow-up exactly as it does for a
 * timed reminder. The cost is up to a minute of latency, which "when I get
 * home" can afford.
 */
export async function recordLocationEvent(
  rawPlace: string,
  event: LocationEvent,
  now = Date.now(),
): Promise<RecordResult> {
  const key = normalizePlace(rawPlace);
  if (!key) throw new Error("place is empty");

  const prev = await getPlace(key);
  if (isBounce(prev, event, now)) return { status: "duplicate", place: key };

  const at = new Date(now).toISOString();
  const { error: upErr } = await supabase.from("places").upsert(
    { key, label: prev?.label ?? rawPlace.trim(), last_event: event, last_event_at: at },
    { onConflict: "key" },
  );
  if (upErr) throw new Error(upErr.message);

  // `fire_at is null` is the claim: a concurrent ping can't arm a row twice,
  // and a row the poller is already delivering is never touched.
  const { data, error } = await supabase
    .from("reminders")
    .update({ fire_at: at })
    .eq("status", "pending")
    .is("fire_at", null)
    .eq("trigger_place", key)
    .eq("trigger_event", event)
    .select("id");
  if (error) throw new Error(error.message);

  return { status: "ok", place: key, triggered: data?.length ?? 0 };
}
