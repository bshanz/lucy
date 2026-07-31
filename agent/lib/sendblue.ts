/**
 * Minimal Sendblue REST client (free-sandbox friendly).
 *
 * Endpoints verified against @sendblue/cli's dist/lib/api.js:
 *  - POST /api/send-message            { number, content, from_number?, media_url? }
 *  - GET  /api/v2/messages?...         → { data: SendblueMessage[], pagination: { total, hasMore } }
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
