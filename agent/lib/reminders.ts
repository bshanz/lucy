import { supabase } from "#lib/supabase.js";

export type ReminderChannel = "imessage" | "slack";

export interface ReminderRow {
  id: string;
  channel: ReminderChannel;
  phone: string | null;
  slack_target: { channelId: string; threadTs?: string } | null;
  body: string;
  fire_at: string;
  recurrence: string | null; // daily | weekly | weekdays | monthly | every_N_days
  // 'awaiting_delivery' = handed to the agent, not yet seen leaving for the
  //   owner. reminder-poll's confirmation pass promotes or re-queues it.
  // 'lapsed' = fired, never confirmed, out of nudges. Still on the books.
  status:
    | "pending"
    | "sending"
    | "awaiting_delivery"
    | "sent"
    | "done"
    | "cancelled"
    | "lapsed";
  follow_up_count: number;
  next_follow_up_at: string | null;
  created_at: string;
  /** When a message was OBSERVED leaving for the owner. The follow-up curve
   *  hangs off this, so it must never be stamped from a dispatch alone. */
  sent_at: string | null;
  /** When the dispatch now awaiting confirmation was handed to the agent. */
  dispatched_at: string | null;
  /** Consecutive dispatches never seen to land; resets on confirmation. */
  delivery_attempts: number;
}

const EVERY_N_DAYS = /^every_(\d{1,3})_days$/;

/**
 * Hours after a one-off fires at which nudges 1, 2 and 3 come due: a day, then
 * three days, then a week. Cumulative offsets rather than deltas, so a
 * deadline is a pure function of (sent_at, count) — which is what lets the poll
 * recompute the deadline it nulled out when a dispatch fails, and what keeps
 * the curve from drifting if a tick runs late.
 *
 * It terminates on purpose. Ignoring one nudge means the owner was busy;
 * ignoring three means the thing is done-but-unconfirmed or no longer wanted,
 * and a fourth only teaches him to ignore unprompted messages from Lucy in
 * general — including the flight alerts that are engineered to be rare.
 */
const FOLLOW_UP_OFFSETS_H = [24, 72, 168];

export const MAX_FOLLOW_UPS = FOLLOW_UP_OFFSETS_H.length;

/**
 * Nudges land in the owner-local window 8:00am–9:00pm, inclusive of both
 * endpoints; 2am "did you ever call Alex?" is worse than not asking at all.
 */
const WAKING_START_HOUR = 8;
const WAKING_END_HOUR = 21;

const pad = (n: number) => String(n).padStart(2, "0");

/** Validate a recurrence string; returns null if invalid. */
export function parseRecurrence(r: string): string | null {
  if (["daily", "weekly", "weekdays", "monthly"].includes(r)) return r;
  const m = r.match(EVERY_N_DAYS);
  if (m && Number(m[1]) >= 1) return r;
  return null;
}

/**
 * TRAVEL MODE — a temporary timezone override.
 *
 * OWNER_TIMEZONE is the owner's HOME zone and never changes at runtime. When he
 * travels, a row in channel_state overrides it until a return date, after which
 * it expires on its own (reminder-poll runs the expiry pass, and reads below
 * ignore a lapsed override anyway so a poll outage can never strand him).
 *
 * ownerTimezone() stays SYNCHRONOUS on purpose: it is called inside
 * Intl.DateTimeFormat construction and inside the fixed-point loop in
 * ownerWallClockToUtc, and making it async would ripple through every pure
 * function in this file. So the override is cached in module scope and every
 * ingress path primes it first. A path that forgets falls back to the home
 * zone — degraded to today's behaviour, never broken.
 */
export type TravelOverride = {
  /** IANA zone he's currently in. */
  timezone: string;
  /** UTC instant the override lapses: 23:59 on his last day away, local to it. */
  until: string;
  setAt: string;
};

const TZ_KEY = "owner_timezone";

/**
 * How long a primed value is trusted. Long enough that a multi-step turn does
 * not re-read per tool call, short enough that a warm Fluid Compute instance
 * cannot serve a stale zone for more than a minute after a switch.
 */
const TZ_TTL_MS = 60_000;

let tzCache: { tz: string; ov: TravelOverride | null; at: number } | null = null;

/** The permanent home zone. The thing travel mode always reverts to. */
export function homeTimezone(): string {
  return process.env.OWNER_TIMEZONE || "America/New_York";
}

/**
 * Is this a real IANA Area/Location zone? Dependency-free.
 *
 * The slash is load-bearing, and NOT cosmetic. ICU also accepts bare
 * abbreviations, and two of them are traps that fail silently:
 *
 *   "EST" → America/Panama      (no daylight saving)
 *   "MST" → America/Phoenix     (no daylight saving)
 *
 * A model reaching for "EST" to mean Eastern would pin him to a zone that
 * never springs forward, putting every reminder an hour off for the whole of
 * summer with nothing to show for it in the logs. Requiring Area/Location
 * rejects those while accepting every zone anyone actually travels to.
 */
export function isValidTimezone(tz: string): boolean {
  if (!tz.includes("/")) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * The zone to interpret every wall clock in. Falls back to home whenever the
 * cache is cold, which is the conservative direction: an unprimed path behaves
 * exactly as it did before travel mode existed.
 */
export function ownerTimezone(): string {
  if (tzCache && Date.now() - tzCache.at < TZ_TTL_MS) return tzCache.tz;
  return homeTimezone();
}

/**
 * The override currently in force, read synchronously from the primed cache.
 * Null when he is home OR when nothing has primed yet — callers must treat it
 * as "no travel note to show", never as proof he is home.
 */
export function activeTravelOverride(): TravelOverride | null {
  if (tzCache && Date.now() - tzCache.at < TZ_TTL_MS) return tzCache.ov;
  return null;
}

/**
 * The active override, or null if there is none, it has lapsed, or it names a
 * zone this runtime cannot resolve. Expiry is enforced HERE, on the read path,
 * so the zone is correct even if the expiry pass in reminder-poll never runs.
 */
export async function readTravelOverride(): Promise<TravelOverride | null> {
  const { data, error } = await supabase
    .from("channel_state")
    .select("value")
    .eq("key", TZ_KEY)
    .maybeSingle();
  if (error) throw new Error(error.message);

  const ov = data?.value as TravelOverride | undefined;
  if (!ov?.timezone || !ov.until) return null;
  if (!isValidTimezone(ov.timezone)) return null;
  if (new Date(ov.until).getTime() <= Date.now()) return null;
  return ov;
}

/**
 * Load the override into the cache. Every channel turn and every schedule tick
 * calls this before touching a clock; scripts/check-timezone-override.ts
 * asserts that none of them forget.
 *
 * A Supabase blip must not put him back on Eastern mid-trip, so on error we
 * keep whatever was already cached and only fall back to home when there is
 * nothing to keep.
 */
export async function primeOwnerTimezone(): Promise<string> {
  if (tzCache && Date.now() - tzCache.at < TZ_TTL_MS) return tzCache.tz;
  try {
    const ov = await readTravelOverride();
    tzCache = { tz: ov?.timezone ?? homeTimezone(), ov, at: Date.now() };
  } catch {
    if (tzCache) tzCache.at = Date.now();
    else tzCache = { tz: homeTimezone(), ov: null, at: Date.now() };
  }
  return tzCache.tz;
}

/** Write the override and prime the cache to it. */
export async function writeTravelOverride(ov: TravelOverride): Promise<void> {
  const { error } = await supabase
    .from("channel_state")
    .upsert({ key: TZ_KEY, value: ov, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) throw new Error(error.message);
  tzCache = { tz: ov.timezone, ov, at: Date.now() };
}

/**
 * If a travel override has lapsed, retire it and move his repeating reminders
 * back to home-zone wall clocks. Returns what happened, or null if there was
 * nothing to do. reminder-poll calls this once a tick.
 *
 * Reads the row directly rather than through readTravelOverride, which hides
 * lapsed overrides by design — this is the one caller that needs to see one.
 */
export async function expireTravelOverrideIfDue(): Promise<
  { from: string; to: string; reanchored: number } | null
> {
  const { data, error } = await supabase
    .from("channel_state")
    .select("value")
    .eq("key", TZ_KEY)
    .maybeSingle();
  if (error) throw new Error(error.message);

  const ov = data?.value as TravelOverride | undefined;
  if (!ov?.timezone || !ov.until) return null;
  if (new Date(ov.until).getTime() > Date.now()) return null;

  const home = homeTimezone();
  await clearTravelOverride();
  // A zone the runtime no longer resolves can't be re-anchored FROM, but the
  // override still has to go: leaving it would pin him to a broken zone.
  const reanchored = isValidTimezone(ov.timezone) ? await reanchorRecurring(ov.timezone, home) : 0;
  return { from: ov.timezone, to: home, reanchored };
}

/** Drop the override and prime the cache back to home. */
export async function clearTravelOverride(): Promise<void> {
  const { error } = await supabase.from("channel_state").delete().eq("key", TZ_KEY);
  if (error) throw new Error(error.message);
  tzCache = { tz: homeTimezone(), ov: null, at: Date.now() };
}

/** The current date/time in the owner's timezone, for grounding the model. */
export function nowInOwnerTz(): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: ownerTimezone(),
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date());
}

/**
 * The grounding line every ingress path attaches to a turn.
 *
 * Lucy has no clock of her own: eve puts no date in the system prompt, and the
 * instructions are captured at build time, so without this she genuinely does
 * not know what day it is and resolves "tomorrow" by shelling out to `date` in
 * a Vercel sandbox — 30 seconds of cold start to learn something we already
 * know. It lives on the message rather than in the instructions on purpose: a
 * timestamp in an always-prepended system prompt changes every turn and
 * invalidates the prompt cache for the whole conversation, where one attached
 * to the newest message only ever appends.
 *
 * Every path that starts a turn must send it — the two channels do, and the
 * evals import it so what they exercise is what production sends.
 */
export function ownerTimeContext(): string[] {
  const ov = activeTravelOverride();
  if (!ov) return [`Current local time: ${nowInOwnerTz()}.`];
  // Travel state rides here rather than in a get_timezone tool: the model needs
  // it on every turn to answer "what time is it back home?" without a round
  // trip, and the session prompt is captured at session.started so it would go
  // stale the moment he switches mid-conversation.
  return [
    `Current local time: ${nowInOwnerTz()}. He is TRAVELING in ${ov.timezone} ` +
      `(home zone ${homeTimezone()}), reverting automatically on ${formatLocal(ov.until)}.`,
  ];
}

/** Format a UTC timestamp in the owner's timezone for confirmations. */
export function formatLocal(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: ownerTimezone(),
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(iso));
}

/** Wall-clock components of a UTC instant, rendered in the owner's timezone. */
function wallClockInTz(date: Date, timeZone: string): {
  year: number; month: number; day: number; hour: number; minute: number; second: number;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: get("year"), month: get("month"), day: get("day"),
    hour: get("hour") % 24, minute: get("minute"), second: get("second"),
  };
}

/**
 * The current hour (0-23) in the owner's timezone. Vercel evaluates cron in UTC
 * with no DST, so a schedule that must land at a civil hour runs hourly and
 * gates on this instead of hardcoding a UTC hour that drifts twice a year — and
 * that would be plain wrong for any non-US value of OWNER_TIMEZONE.
 */
export function ownerLocalHour(): number {
  return wallClockInTz(new Date(), ownerTimezone()).hour;
}

/**
 * Is it a civil hour to text him unprompted? Same window the follow-up curve
 * clamps to. Anything Lucy says on her own initiative, rather than in reply,
 * has to pass this.
 */
export function isWakingHour(): boolean {
  const h = ownerLocalHour();
  return h >= WAKING_START_HOUR && h < WAKING_END_HOUR;
}

/**
 * Convert a wall-clock time in the owner's timezone to a UTC Date, handling
 * DST correctly. Accepts "YYYY-MM-DDTHH:mm" or "YYYY-MM-DDTHH:mm:ss".
 * The model never does offset math — it just passes the time the owner said.
 */
export function ownerWallClockToUtc(wall: string): Date | null {
  return wallClockToUtc(wall, ownerTimezone());
}

/**
 * The same conversion against an EXPLICIT zone. Travel mode needs to read a
 * wall clock in one zone and re-resolve it in another, and Resy needs drop
 * times pinned to the home zone regardless of where the owner is standing.
 */
export function wallClockToUtc(wall: string, tz: string): Date | null {
  const m = wall.trim().match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number) as unknown as number[];

  // Start from the naive-UTC interpretation, then correct by the difference
  // between the target wall clock and what that guess renders as in the tz.
  // Two iterations converge across DST boundaries.
  let guess = Date.UTC(y, mo - 1, d, h, mi, s || 0);
  for (let i = 0; i < 2; i++) {
    const w = wallClockInTz(new Date(guess), tz);
    const rendered = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
    const target = Date.UTC(y, mo - 1, d, h, mi, s || 0);
    guess += target - rendered;
  }
  return new Date(guess);
}

/**
 * Move an instant out of the owner-local quiet window, to whichever edge of it
 * is nearer. Follow-ups are offset from whenever the reminder happened to fire,
 * so without this a 10pm reminder nudges at 10pm, then 10pm, then 10pm.
 *
 * Nearer edge rather than always-forward, because always-forward turns a 1-hour
 * conflict into a 10-hour delay: a 10pm deadline would slide to 8am the next
 * morning and the "24h" nudge would arrive 34h after the reminder. Snapping to
 * the nearer edge moves a deadline by at most half the quiet window (5.5h),
 * and the gaps in the curve are 48h and 96h, so nudges can never reorder or
 * land in the past.
 */
function toWakingHours(d: Date): Date {
  const tz = ownerTimezone();
  const w = wallClockInTz(d, tz);
  if (w.hour >= WAKING_START_HOUR && w.hour < WAKING_END_HOUR) return d;

  // Midpoint of the quiet window, which wraps midnight: 9pm + 5.5h = 2:30am.
  const quietMidHour = (WAKING_END_HOUR + (WAKING_START_HOUR + 24 - WAKING_END_HOUR) / 2) % 24;
  // Evening (>= 9pm) and the small hours (before 2:30am) are nearer the 9pm
  // behind them; 2:30am–8am is nearer the 8am ahead.
  const snapBack = w.hour >= WAKING_END_HOUR || w.hour < quietMidHour;
  const dayShift = w.hour < WAKING_START_HOUR && snapBack ? -1 : 0;
  const hour = snapBack ? WAKING_END_HOUR : WAKING_START_HOUR;

  const day = new Date(Date.UTC(w.year, w.month - 1, w.day + dayShift));
  const wall = `${day.getUTCFullYear()}-${pad(day.getUTCMonth() + 1)}-${pad(day.getUTCDate())}T${pad(hour)}:00`;
  return ownerWallClockToUtc(wall) ?? d;
}

/**
 * When nudge number `count + 1` comes due, or null once the curve is spent —
 * the caller lapses the reminder at that point: no more outreach, still listed.
 */
export function nextFollowUpAt(sentAt: string, count: number): string | null {
  const offsetH = FOLLOW_UP_OFFSETS_H[count];
  if (offsetH === undefined) return null;
  const due = new Date(new Date(sentAt).getTime() + offsetH * 3600 * 1000);
  return toWakingHours(due).toISOString();
}

export function nextOccurrence(fireAt: string, recurrence: string): string {
  const tz = ownerTimezone();
  // Step the OWNER-TIMEZONE wall clock, not raw UTC, so a 5pm reminder stays
  // 5pm across DST changes. Repeat until in the future (covers downtime gaps).
  let d = new Date(fireAt);
  do {
    const w = wallClockInTz(d, tz);
    let dt: Date;

    if (recurrence === "monthly") {
      // Same day next month, clamped to month length (Jan 31 → Feb 28).
      const y = w.month === 12 ? w.year + 1 : w.year;
      const mo = w.month === 12 ? 1 : w.month + 1;
      const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
      dt = new Date(Date.UTC(y, mo - 1, Math.min(w.day, daysInMonth)));
    } else {
      const stepDays =
        recurrence === "weekly" ? 7 :
        recurrence === "daily" || recurrence === "weekdays" ? 1 :
        Number(recurrence.match(EVERY_N_DAYS)?.[1] ?? 1);
      dt = new Date(Date.UTC(w.year, w.month - 1, w.day + stepDays));
      if (recurrence === "weekdays") {
        while (dt.getUTCDay() === 0 || dt.getUTCDay() === 6) {
          dt.setUTCDate(dt.getUTCDate() + 1);
        }
      }
    }

    const next = ownerWallClockToUtc(
      `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}T${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")}:${String(w.second).padStart(2, "0")}`,
    );
    if (!next) return d.toISOString();
    d = next;
  } while (d.getTime() <= Date.now());
  return d.toISOString();
}

/** A UTC instant rendered as a bare "YYYY-MM-DDTHH:mm:ss" wall clock in `tz`. */
function wallClockString(date: Date, tz: string): string {
  const w = wallClockInTz(date, tz);
  return `${w.year}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}`;
}

/**
 * Move live RECURRING reminders so their local wall clock survives a timezone
 * switch, and return how many moved.
 *
 * This is the whole reason travel mode needs a write and not just a flipped
 * zone. fire_at is a UTC instant, and nextOccurrence steps the wall clock in
 * whatever zone is active AT FIRE TIME — so a series crossing a switch
 * preserves its INSTANT, not its hour. Left alone, the 7:45pm check-in would
 * arrive at 4:45pm in San Francisco, before he has eaten dinner, and keep
 * doing so every night of the trip.
 *
 * One-offs are deliberately untouched: "call mom Thursday 5pm" was agreed as a
 * moment in time, often with someone else, and moving it would be a surprise.
 * Recurring reminders are habits pinned to his day, so they follow him.
 */
export async function reanchorRecurring(fromTz: string, toTz: string): Promise<number> {
  if (fromTz === toTz) return 0;

  const { data, error } = await supabase
    .from("reminders")
    .select("id, fire_at, recurrence")
    .not("recurrence", "is", null)
    // Every live state of a series. A poll tick mid-dispatch could race this;
    // the window is one minute and the worst case is a single occurrence
    // delivered at the old local time, which is why it is not worth locking.
    .in("status", ["pending", "sending", "awaiting_delivery"]);
  if (error) throw new Error(error.message);

  let moved = 0;
  for (const row of (data ?? []) as { id: string; fire_at: string; recurrence: string }[]) {
    const wall = wallClockString(new Date(row.fire_at), fromTz);
    const shifted = wallClockToUtc(wall, toTz);
    if (!shifted) continue;

    // Re-anchoring can land the next occurrence in the past (eastward travel
    // moves it earlier). Roll it forward rather than leaving a row that fires
    // the instant the poll next ticks.
    const fireAt =
      shifted.getTime() <= Date.now()
        ? nextOccurrence(shifted.toISOString(), row.recurrence)
        : shifted.toISOString();
    if (fireAt === row.fire_at) continue;

    const { error: upErr } = await supabase
      .from("reminders")
      .update({ fire_at: fireAt })
      .eq("id", row.id);
    if (upErr) throw new Error(upErr.message);
    moved++;
  }
  return moved;
}

/**
 * How far back to look for one-offs that were probably meant in the NEW zone.
 * Long enough to cover a flight plus the wait to remember to tell her, short
 * enough that it can't sweep in things scheduled from home last week.
 */
const RECENT_ONE_OFF_HOURS = 12;

export type StrandedOneOff = {
  id: string;
  body: string;
  /** What will actually happen if nothing is done, in his new local terms. */
  willFireAt: string;
  /** What he probably meant, in his new local terms. */
  ifMoved: string;
  /** Pass straight to reschedule_reminder to make ifMoved true. */
  moveTo: string;
};

/**
 * One-off reminders set in the last few hours, which a timezone switch has
 * just made suspect.
 *
 * reanchorRecurring deliberately leaves one-offs alone: they are usually a
 * moment agreed with another person, and moving "call mom Thursday 5pm"
 * because he boarded a plane would be a surprise. But that rule assumes the
 * reminder was set AT HOME. Anything he set after landing, before thinking to
 * mention the trip, was typed in the local hour he could see on his phone and
 * stored in the zone Lucy still believed in — so it is now silently wrong by
 * the whole offset.
 *
 * This REPORTS them rather than moving them, because the two cases are
 * genuinely indistinguishable from the data: a 5pm Eastern call scheduled from
 * the airport lounge looks exactly like a 5pm Pacific reminder set on landing.
 * Only he knows which, so Lucy asks. Returns [] when there is nothing to ask
 * about, which is the common case.
 */
export async function recentOneOffs(fromTz: string, toTz: string): Promise<StrandedOneOff[]> {
  if (fromTz === toTz) return [];

  const since = new Date(Date.now() - RECENT_ONE_OFF_HOURS * 3_600_000).toISOString();
  const { data, error } = await supabase
    .from("reminders")
    .select("id, body, fire_at")
    .is("recurrence", null)
    .eq("status", "pending")
    .gte("created_at", since)
    // Something already due is past arguing about.
    .gt("fire_at", new Date().toISOString())
    .order("fire_at", { ascending: true });
  if (error) throw new Error(error.message);

  const out: StrandedOneOff[] = [];
  for (const row of (data ?? []) as { id: string; body: string; fire_at: string }[]) {
    // The wall clock he actually typed, read back in the zone it was stored in.
    const typed = wallClockString(new Date(row.fire_at), fromTz).slice(0, 16);
    const shifted = wallClockToUtc(typed, toTz);
    // Moving it would put it in the past, so there is nothing to offer.
    if (!shifted || shifted.getTime() <= Date.now()) continue;
    out.push({
      id: row.id,
      body: row.body,
      willFireAt: formatLocal(row.fire_at),
      ifMoved: formatLocal(shifted.toISOString()),
      moveTo: typed,
    });
  }
  return out;
}

export { supabase };
