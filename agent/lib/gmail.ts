import { getToken } from "@vercel/connect";

/**
 * Gmail API access for the owner's personal mailbox.
 *
 * Auth is brokered by Vercel Connect: a custom Google OAuth connector
 * (GMAIL_CONNECTOR_UID) holds one grant, created by the owner signing into Google
 * during authorization. No Google secrets in env; Connect stores and
 * refreshes the grant server-side.
 *
 * The Google OAuth client must request scope
 * https://www.googleapis.com/auth/gmail.modify and the authorization params
 * access_type=offline & prompt=consent, or Google never issues a refresh
 * token and this dies after ~1 hour. The consent screen must be PUBLISHED
 * (not "Testing") or refresh tokens expire after 7 days.
 *
 * CRITICAL: Connect buckets user grants by the CALLER's environment (the OIDC
 * token's environment claim). A grant created from a laptop is invisible to
 * production. The production grant must be created FROM production — see the
 * /eve/v1/gmail/authorize route in channels/sendblue.ts and
 * scripts/authorize-gmail.mjs for local dev.
 */

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

export function ownerEmailAddress(): string {
  const email = process.env.OWNER_EMAIL;
  if (!email) throw new Error("OWNER_EMAIL is not set");
  return email.toLowerCase();
}

// Must match scripts/authorize-gmail.mjs. scopes: ["*"] = the connector's
// configured default scopes; omitting scopes makes Connect fail with
// "User authorization required" even when the grant exists.
export const OWNER_SUBJECT = {
  type: "user",
  id: process.env.GMAIL_CONNECT_SUBJECT || "owner",
  issuer: process.env.AGENT_NAME?.toLowerCase() || "lucy",
} as const;

export function gmailConnectorUid(): string {
  const uid = process.env.GMAIL_CONNECTOR_UID;
  if (!uid) throw new Error("GMAIL_CONNECTOR_UID is not set");
  return uid;
}

async function gmailToken(): Promise<string> {
  return getToken(gmailConnectorUid(), { subject: OWNER_SUBJECT, scopes: ["*"] });
}

/**
 * Authenticated fetch against any Google API using the same connector grant
 * (the connector's scopes cover Gmail, Calendar, and Tasks). Used by the
 * calendar/tasks tools.
 */
export async function googleApiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const token = await gmailToken();
  const res = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8",
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Google API ${init?.method ?? "GET"} ${url} → ${res.status}: ${body.slice(0, 300)}`,
    );
  }
  return (await res.json()) as T;
}

async function gmailFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await gmailToken();
  const res = await fetch(`${GMAIL_API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8",
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Gmail API ${init?.method ?? "GET"} ${path} → ${res.status}: ${body.slice(0, 300)}`,
    );
  }
  return (await res.json()) as T;
}

export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailMessagePart {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { data?: string; size?: number };
  parts?: GmailMessagePart[];
}

export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  internalDate?: string;
  snippet?: string;
  payload?: GmailMessagePart;
}

export async function listMessageIds(
  q: string,
  maxResults = 15,
): Promise<Array<{ id: string; threadId: string }>> {
  const data = await gmailFetch<{ messages?: Array<{ id: string; threadId: string }> }>(
    `/messages?q=${encodeURIComponent(q)}&maxResults=${maxResults}`,
  );
  return data.messages ?? [];
}

export async function getMessage(id: string): Promise<GmailMessage> {
  return gmailFetch<GmailMessage>(`/messages/${id}?format=full`);
}

export function headerValue(headers: GmailHeader[] | undefined, name: string): string | null {
  const lower = name.toLowerCase();
  return headers?.find((h) => h.name.toLowerCase() === lower)?.value ?? null;
}

/** Extract the bare address from an RFC 5322 From/To header ("Name <a@b.c>"). */
export function parseAddress(header: string | null): string | null {
  if (!header) return null;
  const angled = header.match(/<([^<>\s]+@[^<>\s]+)>/);
  const bare = angled?.[1] ?? header.match(/([^\s"<>,;]+@[^\s"<>,;]+)/)?.[1];
  return bare ? bare.toLowerCase() : null;
}

function decodeBody(data: string | undefined): string {
  if (!data) return "";
  return Buffer.from(data, "base64url").toString("utf-8");
}

function findPart(part: GmailMessagePart | undefined, mimeType: string): GmailMessagePart | null {
  if (!part) return null;
  if (part.mimeType === mimeType && part.body?.data) return part;
  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType);
    if (found) return found;
  }
  return null;
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');
}

/** Drop quoted reply history and signatures so long threads don't bloat prompts. */
function stripQuotedHistory(text: string): string {
  const markers = [
    /^On .{0,200} wrote:\s*$/m,
    /^-{2,}\s*Original Message\s*-{2,}/im,
    /^_{10,}\s*$/m,
    /^-- \s*$/m, // signature delimiter
  ];
  let cut = text.length;
  for (const marker of markers) {
    const match = marker.exec(text);
    if (match && match.index < cut) cut = match.index;
  }
  return text
    .slice(0, cut)
    .split("\n")
    .filter((line) => !line.startsWith(">"))
    .join("\n")
    .trim();
}

/** Best-effort plain-text body: prefer text/plain, fall back to stripped HTML. */
export function getPlainTextBody(msg: GmailMessage): string {
  const plain = findPart(msg.payload, "text/plain");
  if (plain) return stripQuotedHistory(decodeBody(plain.body?.data));
  const html = findPart(msg.payload, "text/html");
  if (html) return stripQuotedHistory(stripHtml(decodeBody(html.body?.data)));
  if (msg.payload?.body?.data) {
    const raw = decodeBody(msg.payload.body.data);
    return stripQuotedHistory(msg.payload.mimeType === "text/html" ? stripHtml(raw) : raw);
  }
  return "";
}

export interface InboundThreadHeaders {
  from: string;
  subject: string;
  messageId: string | null;
  references: string[];
}

/**
 * Headers of the newest message in the thread NOT sent by the owner. Fetched
 * fresh at send time so reply threading never uses stale state.
 */
export async function getLatestInboundHeaders(
  threadId: string,
): Promise<InboundThreadHeaders | null> {
  const thread = await gmailFetch<{ messages?: GmailMessage[] }>(
    `/threads/${threadId}?format=metadata` +
      "&metadataHeaders=From&metadataHeaders=Subject" +
      "&metadataHeaders=Message-ID&metadataHeaders=References",
  );
  const owner = ownerEmailAddress();
  const inbound = (thread.messages ?? [])
    .filter((m) => parseAddress(headerValue(m.payload?.headers, "From")) !== owner)
    .at(-1);
  if (!inbound) return null;

  const headers = inbound.payload?.headers;
  return {
    from: headerValue(headers, "From") ?? "",
    subject: headerValue(headers, "Subject") ?? "",
    messageId: headerValue(headers, "Message-ID"),
    references: (headerValue(headers, "References") ?? "").split(/\s+/).filter(Boolean),
  };
}

/** RFC 2047 encoded-word for non-ASCII header values (Subject). */
function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf-8").toString("base64")}?=`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Light markdown (bold, italics, links, inline code) → simple email HTML. */
export function markdownToEmailHtml(text: string): string {
  const inline = (s: string) =>
    escapeHtml(s)
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>')
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|\s)\*([^*\s][^*\n]*?)\*(?=[\s.,;:!?)]|$)/g, "$1<em>$2</em>")
      .replace(/`([^`\n]+)`/g, "<code>$1</code>");
  const paragraphs = text.replace(/\r\n/g, "\n").trim().split(/\n{2,}/);
  const body = paragraphs
    .map((p) => `<p style="margin:0 0 1em 0;">${inline(p).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#1a1a1a;">\n${body}\n</div>`;
}

/** The same content with markdown syntax stripped, for the text/plain part. */
export function markdownToPlainText(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1 ($2)")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/(^|\s)\*([^*\s][^*\n]*?)\*(?=[\s.,;:!?)]|$)/g, "$1$2")
    .replace(/`([^`\n]+)`/g, "$1");
}

function buildRaw(opts: {
  to: string;
  subject: string;
  text: string;
  inReplyTo?: string | null;
  references?: string[];
}): string {
  const boundary = `lucy-${Buffer.from(opts.subject).toString("hex").slice(0, 16)}-b`;
  const plain = Buffer.from(markdownToPlainText(opts.text), "utf-8").toString("base64");
  const html = Buffer.from(markdownToEmailHtml(opts.text), "utf-8").toString("base64");
  const lines = [
    `From: ${process.env.OWNER_NAME || "Me"} <${ownerEmailAddress()}>`,
    `To: ${opts.to}`,
    `Subject: ${encodeHeader(opts.subject)}`,
    ...(opts.inReplyTo ? [`In-Reply-To: ${opts.inReplyTo}`] : []),
    ...(opts.references?.length ? [`References: ${opts.references.join(" ")}`] : []),
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    plain,
    `--${boundary}`,
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    html,
    `--${boundary}--`,
  ];
  return Buffer.from(lines.join("\r\n"), "utf-8").toString("base64url");
}

export function buildReplyRaw(opts: {
  to: string;
  subject: string;
  inReplyTo: string | null;
  references: string[];
  text: string;
}): string {
  const subject = /^re:/i.test(opts.subject.trim()) ? opts.subject : `Re: ${opts.subject}`;
  return buildRaw({ ...opts, subject });
}

/** A fresh outbound email: no Re: prefix, no threading headers. */
export function buildNewEmailRaw(opts: { to: string; subject: string; text: string }): string {
  return buildRaw(opts);
}

/** Send a reply on an existing thread from the owner's address. */
export async function sendReply(threadId: string, raw: string): Promise<void> {
  await gmailFetch("/messages/send", {
    method: "POST",
    body: JSON.stringify({ raw, threadId }),
  });
}

/** Send a fresh email (new thread) from the owner's address. */
export async function sendEmail(raw: string): Promise<void> {
  await gmailFetch("/messages/send", {
    method: "POST",
    body: JSON.stringify({ raw }),
  });
}
