import type { UserContent } from "ai";

/**
 * Inbound iMessage attachments — deciding what Lucy can actually look at, and
 * turning it into the turn the harness receives.
 *
 * Sendblue uploads every inbound attachment to a public GCS bucket and hands
 * back a `media_url`. Two things about that bucket drive this whole file, both
 * observed on the live account rather than read in a doc:
 *
 *  1. **The Content-Type lies.** A PNG link-preview attachment came back as
 *     `application/octet-stream` with the extension `.pluginPayloadAttachment`.
 *     A HEIC photo came back correctly as `image/heic`. So the header is right
 *     *sometimes*, which is worse than always wrong — nothing about the response
 *     metadata is load-bearing here. We sniff the magic bytes instead.
 *
 *  2. **iPhone camera photos arrive as HEIC, untranscoded.** Sendblue hands over
 *     the original capture. Claude reads JPEG, PNG, GIF and WebP and nothing
 *     else, so a camera photo is unreadable while a *screenshot* (always PNG) is
 *     fine. That split is the entire shape of this feature.
 *
 * The rule that matters most: an image we can't read must still produce a turn.
 * Before this existed, an uncaptioned photo was dropped at the poller's filter
 * and Lucy went silent — no reply, no error, nothing in the log. Silence is the
 * regression this file exists to prevent, so every failure path below degrades
 * to a text marker that Lucy can read out loud, and none of them throw.
 */

/**
 * The formats Claude can actually see. Everything else becomes a marker.
 * Kept as magic-byte prefixes because the wire metadata can't be trusted.
 */
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];

/**
 * ISO base-media brands that mean "HEIF family" — iPhone camera photos, plus
 * AVIF, which Claude also can't read. Matched at bytes 8..12, after the `ftyp`
 * box type at 4..8. The observed photo carried major brand `heic` with
 * `mif1 MiHE miaf MiHB heic` in its compatible-brands list.
 */
const HEIF_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "heif", "mif1", "msf1"]);
const AVIF_BRANDS = new Set(["avif", "avis"]);

/**
 * Cap on what we inline into the turn.
 *
 * These bytes cross eve's queue boundary as a base64 data: URL, so the encoded
 * payload is ~1.33x this. 2 MB covers essentially every iPhone screenshot while
 * keeping the serialized message well clear of anything alarming. It is a
 * transport bound, not a model one — Anthropic's own per-image limit is 10 MB.
 */
export const MAX_INLINE_BYTES = 2_000_000;

/**
 * One part of a multimodal turn. `UserContent` is itself `string | Part[]`, so
 * the element type has to be pulled out of the array branch before you can
 * build one up.
 */
type ContentPart = Extract<UserContent, readonly unknown[]>[number];

export type ImageClassification =
  | { kind: "supported"; mediaType: string }
  | { kind: "unsupported"; label: string }
  | { kind: "unknown" };

function startsWith(bytes: Uint8Array, prefix: readonly number[], offset = 0): boolean {
  if (bytes.byteLength < offset + prefix.length) return false;
  return prefix.every((byte, i) => bytes[offset + i] === byte);
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  if (bytes.byteLength < end) return "";
  return String.fromCharCode(...bytes.subarray(start, end));
}

/**
 * What is this actually, by its bytes?
 *
 * `unsupported` carries a human label because Lucy says it out loud — "that's a
 * HEIC" is a useful thing for the owner to hear, since it tells them the fix
 * (screenshot it). `unknown` is the catch-all for bytes that aren't a
 * recognisable image at all.
 */
export function classifyImage(bytes: Uint8Array): ImageClassification {
  if (startsWith(bytes, PNG)) return { kind: "supported", mediaType: "image/png" };
  if (startsWith(bytes, JPEG)) return { kind: "supported", mediaType: "image/jpeg" };
  if (ascii(bytes, 0, 4) === "GIF8") return { kind: "supported", mediaType: "image/gif" };
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") {
    return { kind: "supported", mediaType: "image/webp" };
  }

  // ISO base-media container: `ftyp` box at 4, major brand at 8.
  if (ascii(bytes, 4, 8) === "ftyp") {
    const brand = ascii(bytes, 8, 12).toLowerCase();
    if (HEIF_BRANDS.has(brand)) return { kind: "unsupported", label: "HEIC" };
    if (AVIF_BRANDS.has(brand)) return { kind: "unsupported", label: "AVIF" };
  }

  return { kind: "unknown" };
}

export type FetchedImage =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: string };

function describeSize(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

/**
 * Download an inbound attachment, refusing anything past the inline cap.
 *
 * Never throws. A dead or slow URL has to degrade into a turn Lucy can still
 * answer — throwing here would un-claim the message in the poller and retry it
 * on every pass forever, which costs the owner the whole conversation rather
 * than just the picture.
 */
export async function fetchInboundImage(url: string): Promise<FetchedImage> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    return { ok: false, reason: "it couldn't be downloaded" };
  }
  if (!res.ok) return { ok: false, reason: `it couldn't be downloaded (HTTP ${res.status})` };

  // Trust content-length only to refuse early — never to accept, since the same
  // response metadata that mislabels PNGs as octet-stream isn't a size oracle.
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_INLINE_BYTES) {
    return { ok: false, reason: `it's ${describeSize(declared)}, past the size you can be sent` };
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch {
    return { ok: false, reason: "it couldn't be downloaded" };
  }
  if (bytes.byteLength > MAX_INLINE_BYTES) {
    return { ok: false, reason: `it's ${describeSize(bytes.byteLength)}, past the size you can be sent` };
  }
  return { ok: true, bytes };
}

/**
 * A note standing in for an image Lucy can't look at.
 *
 * Addressed to the model in second person, like the rest of the per-turn
 * context, and phrased so the reply writes itself: the owner should hear what
 * arrived and what to do about it, not silence and not an error dump.
 */
function marker(reason: string): { type: "text"; text: string } {
  return { type: "text", text: `[The owner texted you an image you can't view: ${reason}.]` };
}

/**
 * `media_url` has been a plain string on every message observed, but an empty
 * string means "no attachment" and the field is loosely typed, so normalise
 * defensively rather than assume it stays scalar.
 */
function mediaUrls(raw: unknown): string[] {
  if (raw === null || raw === undefined) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.filter((url): url is string => typeof url === "string" && url.trim().length > 0);
}

async function partsForUrl(url: string): Promise<ContentPart[]> {
  const fetched = await fetchInboundImage(url);
  if (!fetched.ok) return [marker(fetched.reason)];

  const classified = classifyImage(fetched.bytes);
  if (classified.kind === "unsupported") {
    return [
      marker(
        `it's ${classified.label}, which you can't read — you can read PNG, JPEG, GIF and WebP, ` +
          "so a screenshot works where a camera photo doesn't",
      ),
    ];
  }
  if (classified.kind === "unknown") {
    return [marker("it isn't in a format you can read")];
  }

  // An `image` part, deliberately, NOT a `file` part.
  //
  // eve stages file parts through the sandbox (harness/attachment-staging.js
  // only walks parts where type === "file"), and hydration inlines the bytes
  // back only when the media type starts with "image/" AND the payload is under
  // 3 MB — otherwise the model is handed a text part reading "Attached file
  // /workspace/… (application/octet-stream)". Given this bucket's octet-stream
  // headers that is exactly the failure we'd walk into: the screenshot gets
  // staged, and Claude is shown a filename. An image part skips staging, the
  // sandbox spin-up and the 3 MB cliff outright.
  //
  // The AI SDK marks ImagePart deprecated in favour of FilePart, which is the
  // very shape that triggers all of the above — so the replacement doesn't fit.
  // It is still exported, still in eve's UserContent union, and still works.
  // This function is the only place that builds one; if it's ever removed, this
  // is the single thing that changes.
  //
  // A data: URL rather than raw bytes because the part is JSON-serialized
  // across eve's queue, and a Uint8Array does not survive that round trip.
  const base64 = Buffer.from(fetched.bytes).toString("base64");
  return [
    {
      type: "image",
      image: `data:${classified.mediaType};base64,${base64}`,
      mediaType: classified.mediaType,
    },
  ];
}

/** Does this message carry anything worth waking Lucy for? */
export function hasPayload(msg: { content?: string | null; media_url?: unknown }): boolean {
  return (msg.content ?? "").trim().length > 0 || mediaUrls(msg.media_url).length > 0;
}

/**
 * The inbound message as the harness should receive it.
 *
 * Returns a bare STRING whenever the turn is text-only, and this is
 * load-bearing rather than tidiness: the channel's approve/deny matcher
 * (matchPendingResponses) only runs when `typeof message === "string"`, so
 * wrapping ordinary text in a parts array would silently break every pending
 * approval reply. Arrays are reserved for turns that genuinely carry an image.
 *
 * Images come before the caption because that ordering measurably reads better
 * — Anthropic's vision guidance is explicit that image-then-text outperforms
 * the reverse.
 */
export async function buildTurnMessage(msg: {
  content?: string | null;
  media_url?: unknown;
}): Promise<string | UserContent> {
  const text = (msg.content ?? "").trim();
  const urls = mediaUrls(msg.media_url);
  if (urls.length === 0) return text;

  const parts: ContentPart[] = [];
  for (const url of urls) {
    parts.push(...(await partsForUrl(url)));
  }
  if (text.length > 0) parts.push({ type: "text", text });

  // Everything degraded to a single note (an unreadable photo with no caption):
  // collapse back to a plain string so the turn stays on the ordinary text path.
  if (parts.length === 1 && parts[0].type === "text") return parts[0].text;
  if (parts.length === 0) return text;
  return parts;
}
