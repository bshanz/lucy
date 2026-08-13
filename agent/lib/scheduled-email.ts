import { supabase } from "#lib/supabase.js";

/**
 * Shared types and bounds for pre-approved outbound email.
 *
 * The timezone and formatting helpers deliberately live in #lib/reminders.js and
 * are re-exported here rather than reimplemented: ownerWallClockToUtc already
 * converges across DST boundaries, and a second copy of that arithmetic is a
 * second place for a 9am email to go out at 8am in November.
 */
export type ScheduledEmailChannel = "imessage" | "slack";

export interface ScheduledEmailRow {
  id: string;
  to_address: string;
  subject: string;
  body: string;
  send_at: string;
  channel: ScheduledEmailChannel;
  phone: string | null;
  slack_target: { channelId: string; threadTs?: string } | null;
  status: "scheduled" | "sending" | "sent" | "cancelled" | "failed";
  claimed_at: string | null;
  sent_at: string | null;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * A backstop, not a quota. Nothing here is metered — the cap exists because a
 * model that has misread a conversation can queue outbound mail as fast as it
 * can call a tool, and twenty is far past any real use while still being a
 * number a person would notice.
 */
export const MAX_SCHEDULED = 20;

/**
 * Refuse a send time this close to now. create_reminder allows 60s because a
 * reminder that fires the moment you ask for it is merely redundant; an email
 * that does isn't scheduling, it's send_email with extra steps and no chance to
 * catch a mistake on the card.
 */
export const MIN_LEAD_MS = 120_000;

/** A 'sending' row older than this was orphaned by a crash mid-send. */
export const STUCK_MS = 10 * 60_000;

export { supabase };
