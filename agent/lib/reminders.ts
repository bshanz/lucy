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
  // 'lapsed' = fired, never confirmed, out of nudges. Still on the books.
  status: "pending" | "sending" | "sent" | "done" | "cancelled" | "lapsed";
  follow_up_count: number;
  next_follow_up_at: string | null;
  created_at: string;
  sent_at: string | null;
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

export function ownerTimezone(): string {
  return process.env.OWNER_TIMEZONE || "America/New_York";
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
 * Convert a wall-clock time in the owner's timezone to a UTC Date, handling
 * DST correctly. Accepts "YYYY-MM-DDTHH:mm" or "YYYY-MM-DDTHH:mm:ss".
 * The model never does offset math — it just passes the time the owner said.
 */
export function ownerWallClockToUtc(wall: string): Date | null {
  const m = wall.trim().match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number) as unknown as number[];
  const tz = ownerTimezone();

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

export { supabase };
