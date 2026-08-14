import { createHash } from "node:crypto";
import { uploadFile } from "#lib/sendblue.js";
import { supabase } from "#lib/supabase.js";

/**
 * The assistant's own contact card, attached to the first text to any number.
 *
 * WHY A CARD AND NOT JUST THE SENTENCE. These texts leave from the Sendblue line,
 * so without it the recipient sees an unexplained number forever — the intro
 * sentence explains the first message and nothing after it. One tap on the card
 * and every later text shows up under a name instead.
 *
 * The card identifies the ASSISTANT, not the owner. That's the honest version of
 * what this number is: messages from it are the owner's words, but the line
 * belongs to his assistant, and a card claiming to be his personal mobile would
 * put his real number in the recipient's phone pointing at the wrong place. It
 * also means the card carries nothing private — a phone number the recipient is
 * receiving anyway — which matters because Sendblue hosts it at a public
 * unauthenticated URL (see uploadFile).
 *
 * Everything here is generic and env-driven, same rule as agent/instructions.ts:
 * nothing personal in committed source.
 */

/** vCard escaping: backslash, comma and semicolon are structural in a value. */
function esc(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,");
}

/** Where scripts/set-contact-photo.ts leaves the avatar. */
export const PHOTO_KEY = "contact_card_photo";

/**
 * RFC 2426 line folding: no line over 75 octets, continuations begin with a
 * single space. Irrelevant for every other property here and non-negotiable for
 * PHOTO, whose base64 runs to tens of thousands of characters — an unfolded photo
 * line is the classic way to produce a vCard that some clients silently ignore.
 */
function fold(line: string): string {
  if (line.length <= 75) return line;
  const parts = [line.slice(0, 75)];
  for (let i = 75; i < line.length; i += 74) parts.push(` ${line.slice(i, i + 74)}`);
  return parts.join("\r\n");
}

/** The stored avatar, or null if none was ever set. Never throws — a card without
 *  a photo is a working card, and a broken lookup must not stop a text. */
async function photoLine(): Promise<string | null> {
  try {
    const { data } = await supabase
      .from("channel_state")
      .select("value")
      .eq("key", PHOTO_KEY)
      .maybeSingle();
    const photo = data?.value as { base64?: string; type?: string } | undefined;
    if (!photo?.base64) return null;
    return fold(`PHOTO;ENCODING=b;TYPE=${photo.type ?? "JPEG"}:${photo.base64}`);
  } catch (err) {
    console.error("[contact-card] couldn't read the stored photo", err);
    return null;
  }
}

export function agentName(): string {
  return process.env.AGENT_NAME || "Lucy";
}

/**
 * Build the vCard. CRLF line endings are not cosmetic — RFC 6350 requires them,
 * and some clients quietly refuse a card that uses bare newlines.
 *
 * A single given name and no surname, on purpose: it saves as "Lucy", which is
 * what the owner's friends will hear him call her. The ORG line is what stops
 * that being a mystery in their address book.
 */
export async function buildVCard(): Promise<string> {
  const name = agentName();
  const owner = process.env.OWNER_NAME;
  const number = process.env.SENDBLUE_FROM_NUMBER;
  if (!number) throw new Error("SENDBLUE_FROM_NUMBER is not set");
  const photo = await photoLine();

  const lines = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `N:;${esc(name)};;;`,
    `FN:${esc(name)}`,
    ...(owner ? [`ORG:${esc(`${owner}'s assistant`)}`] : []),
    `TEL;type=CELL;type=VOICE;type=pref:${esc(number)}`,
    ...(owner ? [`NOTE:${esc(`Texts from this number are from ${owner}, sent by ${name}.`)}`] : []),
    // Last, because it dwarfs everything above it and a reader scanning the file
    // should hit the identity first.
    ...(photo ? [photo] : []),
    "END:VCARD",
  ];
  return `${lines.join("\r\n")}\r\n`;
}

/** channel_state key, derived from the card itself. */
function cacheKey(vcard: string): string {
  return `contact_card:${createHash("sha256").update(vcard).digest("hex").slice(0, 32)}`;
}

/**
 * The hosted URL for the current card, uploading it the first time.
 *
 * Keyed by a hash of the card's contents rather than a fixed key, so changing
 * AGENT_NAME, OWNER_NAME or the line number produces a new key and a fresh
 * upload automatically. A fixed key would keep serving the old card forever and
 * there would be nothing to notice it by.
 */
export async function contactCardUrl(): Promise<string> {
  const vcard = await buildVCard();
  const key = cacheKey(vcard);

  const { data } = await supabase.from("channel_state").select("value").eq("key", key).maybeSingle();
  const cached = (data?.value as { media_url?: string } | undefined)?.media_url;
  if (cached) return cached;

  const url = await uploadFile(`${agentName().toLowerCase()}.vcf`, vcard, "text/vcard");

  const { error } = await supabase
    .from("channel_state")
    .upsert({ key, value: { media_url: url }, updated_at: new Date().toISOString() });
  // A failed cache write costs one redundant upload next time, nothing more.
  if (error) console.error(`[contact-card] couldn't cache the upload: ${error.message}`);

  return url;
}
