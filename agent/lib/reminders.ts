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
  status: "pending" | "sending" | "sent" | "cancelled";
  created_at: string;
  sent_at: string | null;
}

const EVERY_N_DAYS = /^every_(\d{1,3})_days$/;

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
