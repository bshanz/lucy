import type { UserContent } from "ai";

/**
 * Inbound iMessage attachments — getting an image the owner texted into a form
 * Claude can actually look at.
 *
 * Three things about Sendblue's bucket drive this file, all observed on the live
 * account rather than read in a doc:
 *
 *  1. **Everything the owner sends is HEIC.** Not just camera photos —
 *     screenshots too. `IMG_1447.heic` was a 70 KB screenshot, so iOS transcodes
 *     the on-device PNG to HEIC on send. The only PNGs that have ever landed
 *     here are `.pluginPayloadAttachment` objects, which are iMessage rich-link
 *     previews rather than anything the owner chose to send. An earlier version
 *     of this file assumed the opposite and told him to "send a screenshot
 *     instead" — advice that cannot work, and worse than saying nothing.
 *
 *  2. **Claude can't read HEIC.** JPEG, PNG, GIF and WebP only. So HEIC has to
 *     be decoded here or the feature doesn't exist.
 *
 *  3. **The Content-Type lies.** A PNG came back as `application/octet-stream`
 *     while a HEIC came back correctly as `image/heic`. The header is right
 *     *sometimes*, which is worse than always wrong — so nothing about the
 *     response metadata is load-bearing and we sniff magic bytes instead.
 *
 * The invariant holding the rest together: an image we can't use must still
 * produce a turn. Before any of this existed, an uncaptioned photo was dropped
 * at the poller's filter and Lucy went silent — no reply, no error, nothing in
 * the log. Every failure path below degrades to a note she reads out loud, and
 * none of them throw.
 */

/** Formats Claude reads natively — inlined as-is, no work needed. */
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];

/**
 * ISO base-media brands we hand to libheif. HEIF (iPhone photos and
 * screenshots) plus AVIF, which shares the container.
 *
 * AVIF is in here on purpose even though libheif only decodes it when the
 * emscripten build shipped an AV1 decoder. Rather than guess which, we attempt
 * the decode and let a failure fall through to the marker — self-correcting
 * beats a hardcoded assumption that silently rots.
 */
const HEIF_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "heif", "mif1", "msf1"]);
const AVIF_BRANDS = new Set(["avif", "avis"]);

/**
 * What we'll pull off the bucket. HEIC is dense on the wire — the 12 MP photo
 * that decodes to 46 MB of RGBA is only 1.6 MB compressed — so this bounds
 * decode memory far more than it bounds the download.
 */
const MAX_DOWNLOAD_BYTES = 8_000_000;

/**
 * Refused after decode, before the downscale and encode allocations. The peak
 * is the decode itself, which we can't inspect ahead of time without parsing
 * the container's `ispe` box; MAX_DOWNLOAD_BYTES is what actually bounds that.
 */
const MAX_PIXELS = 50_000_000;

/**
 * What may cross eve's queue, checked against the FINAL encoded bytes — they
 * travel as a base64 data: URL, so the serialized payload is ~1.33x this.
 */
export const MAX_INLINE_BYTES = 2_000_000;

/**
 * Anthropic's high-resolution tier downscales anything past this before the
 * model sees it, so shrinking to it locally costs nothing in fidelity and saves
 * the whole difference in payload. The 12 MP photo encodes to 2.26 MB at full
 * resolution — over the inline cap — and comfortably under it once resampled.
 */
const MAX_LONG_EDGE = 2576;

/**
 * Chosen for legibility, not for bytes. Most of what gets texted here is a
 * screenshot with small text in it, and Anthropic's vision guidance calls out
 * heavy JPEG compression as the thing that makes text unreadable.
 */
const JPEG_QUALITY = 88;

/**
 * One part of a multimodal turn. `UserContent` is itself `string | Part[]`, so
 * the element type has to be pulled out of the array branch before you can
 * build one up.
 */
type ContentPart = Extract<UserContent, readonly unknown[]>[number];

export type ImageClassification =
  | { kind: "supported"; mediaType: string }
  | { kind: "transcodable"; label: string }
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
 * `transcodable` carries a human label only so a decode failure can say which
 * format defeated it. `unknown` is the catch-all for bytes that aren't a
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
    if (HEIF_BRANDS.has(brand)) return { kind: "transcodable", label: "HEIC" };
    if (AVIF_BRANDS.has(brand)) return { kind: "transcodable", label: "AVIF" };
  }

  return { kind: "unknown" };
}

/**
 * Area-average downscale. Proper box resampling rather than bilinear, because
 * point-sampling a 1.6x reduction aliases exactly the thin strokes that make
 * screen text readable. Only ever called with scale < 1.
 */
function downscale(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  maxLongEdge: number,
): { data: Uint8Array; width: number; height: number } {
  const scale = maxLongEdge / Math.max(width, height);
  if (scale >= 1) return { data: new Uint8Array(data.buffer, data.byteOffset, data.length), width, height };

  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const out = new Uint8Array(w * h * 4);

  for (let y = 0; y < h; y++) {
    const sy0 = Math.floor((y * height) / h);
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * height) / h));
    for (let x = 0; x < w; x++) {
      const sx0 = Math.floor((x * width) / w);
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * width) / w));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = sy0; sy < sy1 && sy < height; sy++) {
        for (let sx = sx0; sx < sx1 && sx < width; sx++) {
          const i = (sy * width + sx) * 4;
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
          a += data[i + 3];
          n++;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = a / n;
    }
  }
  return { data: out, width: w, height: h };
}

/**
 * Flatten transparency onto white, in place.
 *
 * jpeg-js drops the alpha channel outright rather than compositing, so a
 * transparent pixel would encode as whatever RGB sat under it — usually black.
 * iOS images are opaque, so this is defensive; the opaque fast path costs one
 * comparison per pixel.
 */
function compositeOnWhite(data: Uint8Array): void {
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3];
    if (alpha === 255) continue;
    const k = alpha / 255;
    data[i] = Math.round(data[i] * k + 255 * (1 - k));
    data[i + 1] = Math.round(data[i + 1] * k + 255 * (1 - k));
    data[i + 2] = Math.round(data[i + 2] * k + 255 * (1 - k));
    data[i + 3] = 255;
  }
}

/**
 * HEIC/AVIF in, JPEG out. `null` on any failure — never throws.
 *
 * Both dependencies are imported lazily and only once the bytes are known to be
 * ISO-BMFF: heic-decode pulls in ~1.4 MB of emscripten JS with libheif's WASM
 * inlined into it, and there is no reason for a plain text turn — or the
 * reminder, flight and resy crons, which never touch an image — to pay for
 * loading and instantiating that.
 *
 * Measured on the two real files from the owner's bucket: a 1.2 MP screenshot
 * round-trips in ~220 ms, a 12.2 MP camera photo in ~2.4 s.
 */
async function transcodeToJpeg(bytes: Uint8Array): Promise<{ bytes: Uint8Array; mediaType: string } | null> {
  try {
    const [{ default: decode }, { default: jpeg }] = await Promise.all([
      import("heic-decode"),
      import("jpeg-js"),
    ]);

    const { width, height, data } = await decode({ buffer: Buffer.from(bytes) });
    if (!width || !height || width * height > MAX_PIXELS) return null;

    const scaled = downscale(data, width, height, MAX_LONG_EDGE);
    compositeOnWhite(scaled.data);

    const encoded = jpeg.encode(
      { data: Buffer.from(scaled.data.buffer, scaled.data.byteOffset, scaled.data.length), width: scaled.width, height: scaled.height },
      JPEG_QUALITY,
    );
    if (encoded.data.byteLength > MAX_INLINE_BYTES) return null;
    return { bytes: new Uint8Array(encoded.data), mediaType: "image/jpeg" };
  } catch (err) {
    console.warn("[inbound-media] transcode failed", err instanceof Error ? err.message : err);
    return null;
  }
}

export type FetchedImage =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: string };

function describeSize(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

/**
 * Download an inbound attachment, refusing anything past the download cap.
 *
 * Never throws. A dead or slow URL has to degrade into a turn Lucy can still
 * answer — throwing here would un-claim the message in the poller and retry it
 * on every pass forever, costing the owner the conversation rather than just
 * the picture.
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
  if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
    return { ok: false, reason: `it's ${describeSize(declared)}, too big to work with` };
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch {
    return { ok: false, reason: "it couldn't be downloaded" };
  }
  if (bytes.byteLength > MAX_DOWNLOAD_BYTES) {
    return { ok: false, reason: `it's ${describeSize(bytes.byteLength)}, too big to work with` };
  }
  return { ok: true, bytes };
}

/**
 * A note standing in for an image Lucy can't look at.
 *
 * Addressed to the model in second person, like the rest of the per-turn
 * context. It deliberately does NOT suggest a fix: the last version told the
 * owner to send a screenshot instead, which was false — his screenshots are
 * HEIC too — and pointing someone at a workaround that cannot work is worse
 * than admitting the thing just failed.
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

function imagePart(bytes: Uint8Array, mediaType: string): ContentPart {
  // An `image` part, deliberately, NOT a `file` part.
  //
  // eve stages file parts through the sandbox (harness/attachment-staging.js
  // only walks parts where type === "file"), and hydration inlines the bytes
  // back only when the media type starts with "image/" AND the payload is under
  // 3 MB — otherwise the model is handed a text part reading "Attached file
  // /workspace/… (application/octet-stream)". Given this bucket's octet-stream
  // headers that is exactly the failure we'd walk into: the image gets staged,
  // and Claude is shown a filename. An image part skips staging, the sandbox
  // spin-up and the 3 MB cliff outright.
  //
  // The AI SDK marks ImagePart deprecated in favour of FilePart, which is the
  // very shape that triggers all of the above — so the replacement doesn't fit.
  // It is still exported, still in eve's UserContent union, and still works.
  // This function is the only place that builds one; if it's ever removed, this
  // is the single thing that changes.
  //
  // A data: URL rather than raw bytes because the part is JSON-serialized
  // across eve's queue, and a Uint8Array does not survive that round trip.
  return {
    type: "image",
    image: `data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`,
    mediaType,
  };
}

async function partsForUrl(url: string): Promise<ContentPart[]> {
  const fetched = await fetchInboundImage(url);
  if (!fetched.ok) return [marker(fetched.reason)];

  const classified = classifyImage(fetched.bytes);

  if (classified.kind === "supported") {
    // The download cap is larger than the inline cap now that HEIC (dense on the
    // wire, huge in memory) sets the former, so an already-readable image can
    // still arrive too big to forward. We have no PNG decoder to shrink it with,
    // so this one says so rather than pretending.
    if (fetched.bytes.byteLength > MAX_INLINE_BYTES) {
      return [marker(`it's ${describeSize(fetched.bytes.byteLength)}, too big to send you`)];
    }
    return [imagePart(fetched.bytes, classified.mediaType)];
  }

  if (classified.kind === "transcodable") {
    const converted = await transcodeToJpeg(fetched.bytes);
    if (converted) return [imagePart(converted.bytes, converted.mediaType)];
    return [marker(`it's ${classified.label} and it couldn't be converted into something you can read`)];
  }

  return [marker("it isn't in a format you can read")];
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

  // Everything degraded to a single note (an unusable image with no caption):
  // collapse back to a plain string so the turn stays on the ordinary text path.
  if (parts.length === 1 && parts[0].type === "text") return parts[0].text;
  if (parts.length === 0) return text;
  return parts;
}
