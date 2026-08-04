import { googleApiFetch } from "#lib/gmail.js";

const EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

export interface GcalAttendee {
  email?: string;
  displayName?: string;
  responseStatus?: string;
  organizer?: boolean;
  self?: boolean;
}

export interface GcalEvent {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  attendees?: GcalAttendee[];
  hangoutLink?: string;
}

/**
 * Cleans a caller-supplied guest list: trims, lowercases, dedupes, and drops
 * the owner's own address. Google adds the organizer to every event it
 * creates, so passing the owner explicitly turns him into an invitee of his
 * own dinner — complete with an RSVP prompt in his inbox.
 */
export function normalizeAttendees(emails: readonly string[] | undefined): string[] {
  const owner = process.env.OWNER_EMAIL?.trim().toLowerCase();
  const seen = new Set<string>();
  for (const raw of emails ?? []) {
    const email = raw.trim().toLowerCase();
    if (!email || email === owner) continue;
    seen.add(email);
  }
  return [...seen];
}

/**
 * Resolves the guest list an update should end up with. A PATCH to Google's
 * events endpoint REPLACES the attendees array rather than merging into it, so
 * "add one guest" has to be read-modify-write or it silently uninvites
 * everyone already on the event.
 */
export function mergeAttendees(
  existing: readonly GcalAttendee[] | undefined,
  add: readonly string[] | undefined,
  remove: readonly string[] | undefined,
): GcalAttendee[] {
  const dropped = new Set(normalizeAttendees(remove));
  const kept = (existing ?? []).filter((a) => {
    const email = a.email?.trim().toLowerCase();
    return email ? !dropped.has(email) : true;
  });
  const present = new Set(
    kept.map((a) => a.email?.trim().toLowerCase()).filter((e): e is string => Boolean(e)),
  );
  for (const email of normalizeAttendees(add)) {
    if (present.has(email)) continue;
    present.add(email);
    kept.push({ email });
  }
  return kept;
}

/**
 * New end time for an event whose start moved but whose end wasn't given.
 * Preserving the original duration is the only sane reading of "push dinner to
 * 8" — the alternative is a one-hour default quietly shortening a three-hour
 * event. Returns null when the original event has no usable timed range (an
 * all-day event), which the caller should treat as "ask for an end time".
 */
export function shiftedEnd(
  originalStart: string | undefined,
  originalEnd: string | undefined,
  newStart: Date,
): Date | null {
  if (!originalStart || !originalEnd) return null;
  const from = Date.parse(originalStart);
  const to = Date.parse(originalEnd);
  if (Number.isNaN(from) || Number.isNaN(to) || to <= from) return null;
  return new Date(newStart.getTime() + (to - from));
}

/** True when a change to this event will email somebody other than the owner. */
export function hasGuests(event: Pick<GcalEvent, "attendees">): boolean {
  return (event.attendees ?? []).some((a) => !a.self && Boolean(a.email));
}

function withSendUpdates(url: string, notify: boolean): string {
  // sendUpdates is a query param, not a body field. Passing "none" for solo
  // events keeps Google from mailing anything at all.
  return `${url}?sendUpdates=${notify ? "all" : "none"}`;
}

export async function getEvent(eventId: string): Promise<GcalEvent> {
  return googleApiFetch<GcalEvent>(`${EVENTS_URL}/${encodeURIComponent(eventId)}`);
}

export async function insertEvent(body: unknown, notify: boolean): Promise<GcalEvent> {
  return googleApiFetch<GcalEvent>(withSendUpdates(EVENTS_URL, notify), {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function patchEvent(
  eventId: string,
  body: unknown,
  notify: boolean,
): Promise<GcalEvent> {
  return googleApiFetch<GcalEvent>(
    withSendUpdates(`${EVENTS_URL}/${encodeURIComponent(eventId)}`, notify),
    { method: "PATCH", body: JSON.stringify(body) },
  );
}
