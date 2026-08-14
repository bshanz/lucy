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

/**
 * Send `content` to `number` and return Sendblue's id for it, when the response
 * carries one.
 *
 * The handle is worth keeping for anything sent to someone other than the owner:
 * it is the only way to answer "did that actually land?" afterwards without
 * guessing, and a text to a friend is the one outbound path here where nobody
 * tells us it failed. Callers that don't care use sendMessage() below.
 */
export async function sendMessageWithHandle(
  number: string,
  content: string,
  mediaUrl?: string | null,
): Promise<string | null> {
  const body: Record<string, string> = { number, content };
  if (mediaUrl) body.media_url = mediaUrl;
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
  // A missing handle is not a failed send — the message is already gone. Report
  // it as absent and let the caller degrade rather than throwing after the wire.
  const json = (await res.json().catch(() => null)) as { message_handle?: string } | null;
  return json?.message_handle ?? null;
}

export async function sendMessage(number: string, content: string): Promise<void> {
  await sendMessageWithHandle(number, content);
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

/**
 * Recent messages in one direction, newest first, optionally for one counterparty.
 *
 * ⚠️ `number` IS NOT A CONVENIENCE — it is what keeps the ingress poll correct now
 * that people other than the owner can be in this inbox. Without it the newest N
 * spans every sender, so a handful of friends replying at once pushes the owner's
 * own text out of the window and Lucy simply never answers him. Verified honoured
 * server-side (a number with no history returns zero rows rather than the newest N).
 */
async function fetchRecent(
  isOutbound: boolean,
  limit: number,
  number?: string,
): Promise<SendblueMessage[]> {
  const params = new URLSearchParams({
    limit: String(limit),
    order_by: "createdAt",
    order_direction: "desc",
    is_outbound: String(isOutbound),
    ...(number ? { number } : {}),
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
 * Recent inbound messages, newest first. Pass `number` to scope to one sender —
 * the ingress poll must, see fetchRecent.
 */
export async function fetchRecentInbound(limit = 25, number?: string): Promise<SendblueMessage[]> {
  return fetchRecent(false, limit, number);
}

/**
 * Upload a file and get back the CDN URL to attach it with.
 *
 * `media_url` on send-message must be a publicly downloadable link ending in the
 * right extension, which would otherwise mean hosting a file ourselves — an
 * unauthenticated route on this app serving the owner's contact details. Sendblue
 * hosts it instead: POST returns a Google Cloud Storage URL that keeps the
 * filename's extension, verified on the free plan (HTTP 201, and the result
 * fetches with no credentials as `text/x-vcard`).
 *
 * ⚠️ That URL IS PUBLIC AND UNAUTHENTICATED — an eight-character random prefix is
 * the only thing standing in front of it. Fine for a card that deliberately hands
 * out a phone number; not a place for anything else.
 */
export async function uploadFile(
  filename: string,
  content: string,
  contentType: string,
): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([content], { type: contentType }), filename);
  const { key, secret } = credentials();
  const res = await fetch(`${API_BASE}/api/upload-file`, {
    method: "POST",
    // No Content-Type header: fetch sets the multipart boundary itself.
    headers: { "sb-api-key-id": key, "sb-api-secret-key": secret },
    body: form,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Sendblue upload failed (${res.status}): ${detail.slice(0, 300)}`);
  }
  const json = (await res.json()) as { media_url?: string };
  if (!json.media_url) throw new Error("Sendblue upload returned no media_url");
  return json.media_url;
}

/**
 * Is this number on the account's contact list?
 *
 * `true` / `false`, or `null` when we couldn't tell — callers must not treat an
 * unreachable lookup as a "no".
 *
 * ⚠️ A `true` here does NOT mean the send will work, and nothing should present it
 * that way. Verified against the live API: creating a contact returns 200 and the
 * subsequent send is still refused with "This contact must be verified before
 * sending messages to it." On the free shared line the only thing that verifies a
 * contact is an inbound text from them. So this is a one-way check — useful for
 * catching a send that is certain to fail before the owner is asked to approve it,
 * useless as a green light.
 */
export async function isKnownContact(number: string): Promise<boolean | null> {
  try {
    const res = await fetch(`${API_BASE}/api/v2/contacts/${encodeURIComponent(number)}`, {
      method: "GET",
      headers: headers(),
    });
    if (res.status === 404) return false;
    if (!res.ok) return null;
    return true;
  } catch {
    return null;
  }
}

/** Compare two numbers by their last ten digits — Sendblue is not guaranteed to
 *  echo back the exact formatting a row was stored with. */
function sameNumber(a: string, b: string): boolean {
  const digits = (s: string) => s.replace(/\D/g, "").slice(-10);
  const left = digits(a);
  return left.length === 10 && left === digits(b);
}

/**
 * Did this exact text already go to this number?
 *
 * The Sendblue-side answer to the question findSentMessage() asks Gmail: an
 * invocation that dies mid-send leaves no way to tell a request that never
 * landed from one that landed and lost its acknowledgement. Retrying blindly
 * texts a real person twice; failing blindly tells the owner a message didn't go
 * when it did. So ask.
 *
 * Content-and-recipient matching rather than handle matching on purpose — the
 * crash we are recovering from is precisely the one where we never got a handle.
 */
export async function findSentText(number: string, content: string): Promise<boolean> {
  // Scoped to this recipient server-side: an unscoped window would have to be
  // enormous to be trustworthy once several conversations share the line, and a
  // false "not found" here tells the owner a text didn't go when it did.
  const recent = await fetchRecent(true, 25, number);
  const want = content.trim();
  return recent.some((m) => sameNumber(m.to_number, number) && (m.content ?? "").trim() === want);
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
