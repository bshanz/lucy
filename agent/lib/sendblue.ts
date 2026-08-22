/**
 * Minimal Sendblue REST client (free-sandbox friendly).
 *
 * Endpoints verified against @sendblue/cli's dist/lib/api.js:
 *  - POST /api/send-message            { number, content, from_number?, media_url? }
 *  - GET  /api/v2/messages?...         → { data: SendblueMessage[], pagination: { total, hasMore } }
 *
 * Verified against docs.sendblue.com only (not present in the CLI):
 *  - POST /api/mark-read               { number, from_number }   // both required
 *
 * Env is read lazily — eve imports modules during discovery without secrets.
 */

const API_BASE = process.env.SENDBLUE_API_BASE || "https://api.sendblue.com";

export interface SendblueMessage {
  content: string | null;
  from_number: string;
  to_number: string;
  is_outbound: boolean;
  status: string;
  date_sent: string;
  media_url?: string | null;
  message_handle?: string;
  id?: string;
  _id?: string;
}

function credentials(): { key: string; secret: string } {
  const key = process.env.SENDBLUE_API_KEY_ID;
  const secret = process.env.SENDBLUE_API_SECRET_KEY;
  if (!key || !secret) {
    throw new Error("SENDBLUE_API_KEY_ID / SENDBLUE_API_SECRET_KEY are not set");
  }
  return { key, secret };
}

function headers(): Record<string, string> {
  const { key, secret } = credentials();
  return {
    "Content-Type": "application/json",
    "sb-api-key-id": key,
    "sb-api-secret-key": secret,
  };
}

export function ownerPhone(): string {
  const phone = process.env.OWNER_PHONE;
  if (!phone) throw new Error("OWNER_PHONE is not set");
  return phone;
}

export async function sendMessage(number: string, content: string): Promise<void> {
  const body: Record<string, string> = { number, content };
  if (process.env.SENDBLUE_FROM_NUMBER) body.from_number = process.env.SENDBLUE_FROM_NUMBER;
  const res = await fetch(`${API_BASE}/api/send-message`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Sendblue send failed (${res.status}): ${detail.slice(0, 300)}`);
  }
}

/** Show the iMessage typing indicator to `number` (expires on its own or when a message sends). */
export async function sendTypingIndicator(number: string): Promise<void> {
  const body: Record<string, string> = { number };
  if (process.env.SENDBLUE_FROM_NUMBER) body.from_number = process.env.SENDBLUE_FROM_NUMBER;
  const res = await fetch(`${API_BASE}/api/send-typing-indicator`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  // Best-effort: a failed indicator should never break the turn.
  if (!res.ok) {
    console.warn(`[sendblue] typing indicator failed (${res.status})`);
  }
}

/**
 * Mark the conversation with `number` as read — the blue "Read 9:41 AM" line
 * under the owner's last text.
 *
 * Call this AFTER the message is claimed, never before: a read receipt is a
 * promise that Lucy has the message and is answering it, so it must not fire
 * for a text that a crashed dispatch will hand back to a later pass. (Sendblue
 * also offers account-level auto mark-read, which fires at their ingress and
 * can't make that guarantee — hence doing it here.)
 *
 * `from_number` is REQUIRED by this endpoint (unlike send-message, where it's
 * optional), so fall back to the line the inbound message was addressed to.
 * iMessage/RCS only — a no-op on SMS, and never confirmed by the recipient.
 */
export async function markRead(number: string, fromNumber?: string): Promise<void> {
  const from = process.env.SENDBLUE_FROM_NUMBER || fromNumber;
  if (!from) {
    console.warn("[sendblue] mark-read skipped: no from_number available");
    return;
  }
  const res = await fetch(`${API_BASE}/api/mark-read`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ number, from_number: from }),
  });
  // Best-effort, exactly like the typing indicator: a missing receipt is
  // cosmetic, and must never cost the owner a reply.
  if (!res.ok) {
    console.warn(`[sendblue] mark-read failed (${res.status})`);
  }
}

/** Recent inbound messages, newest first. */
export async function fetchRecentInbound(limit = 25): Promise<SendblueMessage[]> {
  const params = new URLSearchParams({
    limit: String(limit),
    order_by: "createdAt",
    order_direction: "desc",
    is_outbound: "false",
  });
  const res = await fetch(`${API_BASE}/api/v2/messages?${params}`, {
    method: "GET",
    headers: headers(),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Sendblue messages fetch failed (${res.status}): ${detail.slice(0, 300)}`);
  }
  const json = (await res.json()) as { data?: SendblueMessage[] };
  return json.data ?? [];
}

/**
 * Recent OUTBOUND messages, newest first — Sendblue's own record of what
 * actually left for a number.
 *
 * This is the only trustworthy delivery signal a schedule has. eve's receive()
 * resolves when the session ACCEPTS a message, seconds before any text is
 * composed — and a parked session accepts messages it will never speak. Asking
 * Sendblue what it sent is the one question a wedged session cannot answer
 * falsely, which is what makes it worth a second API call per tick.
 *
 * Outbound payloads put the owner in `to_number` (`from_number` is the Sendblue
 * line) and carry a `status` that is "ERROR" on a failed send — verified
 * against a live response rather than the docs.
 */
export async function fetchRecentOutbound(limit = 25): Promise<SendblueMessage[]> {
  const params = new URLSearchParams({
    limit: String(limit),
    order_by: "createdAt",
    order_direction: "desc",
    is_outbound: "true",
  });
  const res = await fetch(`${API_BASE}/api/v2/messages?${params}`, {
    method: "GET",
    headers: headers(),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Sendblue outbound fetch failed (${res.status}): ${detail.slice(0, 300)}`);
  }
  const json = (await res.json()) as { data?: SendblueMessage[] };
  return json.data ?? [];
}

/**
 * Stable dedupe key for a message. Sendblue's canonical id is message_handle
 * (webhook payloads use it); fall back to other id fields, then to a
 * content-derived key so a missing id can never flood the session.
 */
export function messageKey(msg: SendblueMessage): string {
  return (
    msg.message_handle ||
    msg.id ||
    msg._id ||
    `${msg.from_number}:${msg.date_sent}:${(msg.content ?? "").slice(0, 60)}`
  );
}
