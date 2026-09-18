/**
 * Approval cards for iMessage.
 *
 * eve raises a tool approval as a prompt ("Approve tool call: X") plus the raw
 * call input. Dumped as `key: value` lines that read like a stack trace —
 * `startLocal: 2026-09-28T08:20`, `attendees: ["..."]` — and the owner is
 * supposed to approve on it. Each gated tool gets a card here that says what
 * will happen in his words: when, where, who, how much.
 *
 * Pure: takes the tool name and input, returns lines. Wall-clock strings are
 * rendered as written (they are already owner-local by contract, see
 * ownerWallClockToUtc) so nothing here touches the timezone cache or the
 * network. `scripts/check-approval-card.ts` pins the output.
 *
 * Markdown bold is fine — channel.reply runs toImessageText, which turns it
 * into Unicode bold. Bullets are written as "• " directly.
 */

type Input = Record<string, unknown>;

const BODY_LIMIT = 3000; // email bodies: the card IS the draft, so show all of it
const FIELD_LIMIT = 1200; // anything else

export function formatApprovalCard(toolName: string, input: Input): string[] {
  const render = CARDS[toolName];
  return render ? render(input) : genericCard(toolName, input);
}

const CARDS: Record<string, (input: Input) => string[]> = {
  create_calendar_event: (i) => {
    const lines = [`📅 **Add to calendar?**`, `**${str(i.title)}**`];
    const when = formatWallRange(str(i.startLocal), optStr(i.endLocal));
    if (when) lines.push(when);
    if (i.location) lines.push(`📍 ${str(i.location)}`);
    const guests = list(i.attendees);
    if (guests.length) lines.push(`👥 ${guests.join(", ")}`);
    if (i.description) lines.push("", clip(str(i.description), FIELD_LIMIT));
    return lines;
  },

  update_calendar_event: (i) => {
    const lines = [`📅 **Update this event?**`];
    if (i.title) lines.push(`Title → **${str(i.title)}**`);
    const when = formatWallRange(optStr(i.startLocal), optStr(i.endLocal));
    if (when) lines.push(`When → ${when}`);
    else if (i.endLocal) lines.push(`Ends → ${formatWall(str(i.endLocal))}`);
    if (i.location) lines.push(`📍 ${str(i.location)}`);
    const add = list(i.addAttendees);
    const remove = list(i.removeAttendees);
    if (add.length) lines.push(`➕ Invite ${add.join(", ")}`);
    if (remove.length) lines.push(`➖ Uninvite ${remove.join(", ")}`);
    if (i.description) lines.push("", clip(str(i.description), FIELD_LIMIT));
    lines.push(`Event ${str(i.eventId)}`);
    return lines;
  },

  send_email: (i) => [
    `✉️ **Send this email?**`,
    `To: ${str(i.to)}`,
    `Subject: ${str(i.subject)}`,
    "",
    clip(str(i.body), BODY_LIMIT),
  ],

  schedule_email: (i) => [
    `✉️ **Schedule this email?**`,
    `To: ${str(i.to)}`,
    `Subject: ${str(i.subject)}`,
    `Sends: ${formatWall(str(i.sendAtLocal))}`,
    "",
    clip(str(i.body), BODY_LIMIT),
  ],

  reply_to_email: (i) => [
    `✉️ **Send this reply?**`,
    "",
    clip(str(i.body), BODY_LIMIT),
    "",
    `Thread ${str(i.threadId)}`,
  ],

  book_resy: (i) => [
    `🍽️ **Book this table?**`,
    `${formatDate(str(i.date))} · ${party(i.partySize)}`,
    `Deposit: ${deposit(i.maxDepositCents)}`,
  ],

  snipe_resy: (i) => {
    const who = i.fallbackPartySize
      ? `${party(i.partySize)} (or ${num(i.fallbackPartySize)} if that's all there is)`
      : party(i.partySize);
    const lines = [
      `🎯 **Arm this snipe?**`,
      `**${str(i.venueName)}** · ${formatDate(str(i.reservationDate))} · ${who}`,
    ];
    let seating = `Seating: ${formatClockRange(str(i.earliestTime), str(i.latestTime))}`;
    if (i.preferredTime) seating += `, ideally ${formatClock(str(i.preferredTime))}`;
    lines.push(seating);
    const tables = list(i.slotTypes);
    if (tables.length) lines.push(`Tables: ${tables.join(", then ")}`);
    lines.push(`Deposit: ${deposit(i.maxDepositCents)}`);
    if (i.dropAtLocal) {
      lines.push(`Books at: ${formatWall(str(i.dropAtLocal))}`);
    } else if (i.watchFromLocal && i.watchUntilLocal) {
      let watch = `Watching: ${formatWallRange(str(i.watchFromLocal), str(i.watchUntilLocal))}`;
      if (i.expectedDropLocal) watch += ` (likely around ${formatWall(str(i.expectedDropLocal), { dateIfNeeded: str(i.watchFromLocal) })})`;
      lines.push(watch);
    } else if (i.daysAhead) {
      const at = i.dropTimeLocal ? ` at ${formatClock(str(i.dropTimeLocal))}` : "";
      lines.push(`Books: ${num(i.daysAhead)} days out${at}`);
    } else if (i.dropTimeLocal) {
      lines.push(`Books at: ${formatClock(str(i.dropTimeLocal))}`);
    }
    return lines;
  },

  cancel_resy_booking: (i) => [
    `🍽️ **Cancel this reservation?**`,
    `Reservation ${str(i.resyToken)}`,
  ],
};

/**
 * The reply instructions under a card. Two options (the usual approve/cancel)
 * collapse to one line: "Reply 1 to Approve or 2 to Cancel." More than two
 * get a numbered list. Pinned by scripts/check-approval-card.ts.
 */
export function formatOptions(
  options: { label: string; description?: string }[],
  allowFreeform: boolean,
): string[] {
  if (options.length === 0) return [];
  const lines: string[] = [""];
  if (options.length === 2 && !options.some((o) => o.description)) {
    lines.push(`Reply 1 to ${options[0].label} or 2 to ${options[1].label}.`);
  } else {
    options.forEach((option, index) => {
      lines.push(`${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`);
    });
    lines.push("Reply with a number or option name.");
  }
  if (allowFreeform) lines.push("Or answer in your own words.");
  return lines;
}

function genericCard(toolName: string, input: Input): string[] {
  const lines = [`⚠️ **Approve ${humanize(toolName).toLowerCase()}?**`];
  for (const [key, value] of Object.entries(input)) {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    lines.push(`${humanize(key)}: ${clip(text, FIELD_LIMIT)}`);
  }
  return lines;
}

// ---- pieces ----------------------------------------------------------------

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}
function optStr(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}
function num(v: unknown): number {
  return typeof v === "number" ? v : Number(v);
}
function list(v: unknown): string[] {
  return Array.isArray(v) ? v.map(str).filter(Boolean) : [];
}
function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}… (${text.length - limit} more characters)`;
}
function party(v: unknown): string {
  const n = num(v);
  return n === 1 ? "table for 1" : `party of ${n}`;
}
function deposit(cents: unknown): string {
  const n = num(cents ?? 0);
  if (!n) return "none — card-required tables are skipped";
  return `up to $${(n / 100).toFixed(n % 100 ? 2 : 0)}`;
}

/** "maxDepositCents" → "Max deposit cents"; "snipe_resy" → "Snipe resy". */
export function humanize(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

type Wall = { y: number; mo: number; d: number; h: number; mi: number };

function parseWall(wall: string): Wall | null {
  const m = wall.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (!m) return null;
  return { y: +m[1], mo: +m[2], d: +m[3], h: m[4] ? +m[4] : 0, mi: m[5] ? +m[5] : 0 };
}

// Rendered in UTC on purpose: the string is already the owner's wall clock,
// so no zone may be applied on top of it.
function asDate(w: Wall): Date {
  return new Date(Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi));
}
function dayPart(w: Wall): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(asDate(w));
}
function clockPart(w: Wall, withMeridiem = true): string {
  const text = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    hour: "numeric",
    minute: "2-digit",
  }).format(asDate(w));
  return withMeridiem ? text : text.replace(/\s?[AP]M$/, "");
}
function sameDay(a: Wall, b: Wall): boolean {
  return a.y === b.y && a.mo === b.mo && a.d === b.d;
}
function meridiem(w: Wall): "AM" | "PM" {
  return w.h < 12 ? "AM" : "PM";
}

/** "2026-09-28" → "Mon, Sep 28". Unparseable input is passed through. */
export function formatDate(date: string): string {
  const w = parseWall(date);
  return w ? dayPart(w) : date;
}

function parseClock(hhmm: string): Wall | null {
  const m = hhmm.trim().match(/^(\d{1,2}):(\d{2})$/);
  return m ? { y: 2000, mo: 1, d: 1, h: +m[1], mi: +m[2] } : null;
}

/** "19:00" → "7:00 PM". */
export function formatClock(hhmm: string): string {
  const w = parseClock(hhmm);
  return w ? clockPart(w) : hhmm;
}

/** "19:00","21:00" → "7:00–9:00 PM"; "11:30","13:00" → "11:30 AM–1:00 PM". */
export function formatClockRange(from: string, to: string): string {
  const a = parseClock(from);
  const b = parseClock(to);
  if (!a || !b) return `${formatClock(from)}–${formatClock(to)}`;
  const shared = meridiem(a) === meridiem(b);
  return `${clockPart(a, !shared)}–${clockPart(b)}`;
}

/**
 * "2026-09-28T08:20" → "Mon, Sep 28 · 8:20 AM". With `dateIfNeeded`, the date
 * is dropped when it matches that reference day (a watch window's "likely
 * around" moment sits inside the window; repeating the date is noise).
 */
export function formatWall(wall: string, opts: { dateIfNeeded?: string } = {}): string {
  const w = parseWall(wall);
  if (!w) return wall;
  const ref = opts.dateIfNeeded ? parseWall(opts.dateIfNeeded) : null;
  if (ref && sameDay(w, ref)) return clockPart(w);
  return `${dayPart(w)} · ${clockPart(w)}`;
}

/**
 * Start + optional end as one line:
 *   same day, same half → "Mon, Sep 28 · 8:20–8:40 AM"
 *   same day, AM→PM     → "Mon, Sep 28 · 11:30 AM–12:15 PM"
 *   different days      → "Mon, Sep 28 · 8:20 AM – Tue, Sep 29 · 9:00 AM"
 * Returns "" when there is no start (an update that only moves the end).
 */
export function formatWallRange(start: string | undefined, end: string | undefined): string {
  if (!start) return "";
  const s = parseWall(start);
  if (!s) return end ? `${start} – ${end}` : start;
  const e = end ? parseWall(end) : null;
  if (!e) return formatWall(start);
  if (!sameDay(s, e)) return `${formatWall(start)} – ${formatWall(end!)}`;
  const sharedMeridiem = meridiem(s) === meridiem(e);
  return `${dayPart(s)} · ${clockPart(s, !sharedMeridiem)}–${clockPart(e)}`;
}
