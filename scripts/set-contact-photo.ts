/**
 * Installs the avatar that rides on the assistant's contact card.
 *
 *   npx tsx --env-file=.env.local scripts/set-contact-photo.ts ~/Desktop/lucy.png
 *   npx tsx --env-file=.env.local scripts/set-contact-photo.ts --clear
 *
 * The image is centre-cropped square, scaled to 400px, converted to JPEG and
 * stored base64 in `channel_state` — NOT committed and NOT in env.
 *
 * Not committed, because the repo is public and an avatar is personal. Not env,
 * because a base64 image is tens of kilobytes and env vars are a bad place to put
 * one (Vercel caps the whole set, and a value that size makes every other var
 * unreadable in the dashboard). channel_state already exists, is service-role
 * only, and is where the rest of this feature's derived state lives.
 *
 * Storing it also invalidates the upload for free: contactCardUrl() keys its
 * cache on a hash of the finished vCard, so a new photo produces a new key and a
 * fresh upload with no bookkeeping.
 *
 * Uses `sips`, which ships with macOS. On another OS, produce a square JPEG by
 * any means and the encode/store half still works.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PHOTO_KEY, buildVCard } from "#lib/contact-card.js";
import { supabase } from "#lib/supabase.js";

/** Apple renders a contact photo in a small circle; 400px is past the point of
 *  visible improvement and keeps the card comfortably under any size limit. */
const EDGE = 400;

/** Warn past this. iMessage would carry far more, but a vCard is meant to be a
 *  card — a megabyte of JPEG in an introduction is a smell, not a feature. */
const WARN_BYTES = 120_000;

function sips(args: string[]): string {
  return execFileSync("sips", args, { encoding: "utf8" });
}

function dimensions(path: string): { width: number; height: number } {
  const out = sips(["-g", "pixelWidth", "-g", "pixelHeight", path]);
  const width = Number(/pixelWidth:\s*(\d+)/.exec(out)?.[1]);
  const height = Number(/pixelHeight:\s*(\d+)/.exec(out)?.[1]);
  if (!width || !height) throw new Error(`couldn't read image dimensions from:\n${out}`);
  return { width, height };
}

async function clear(): Promise<void> {
  const { error } = await supabase.from("channel_state").delete().eq("key", PHOTO_KEY);
  if (error) throw new Error(error.message);
  console.log("Contact photo cleared. The next first-text uploads a card without one.");
}

async function install(source: string): Promise<void> {
  const { width, height } = dimensions(source);
  const edge = Math.min(width, height);
  const work = mkdtempSync(join(tmpdir(), "lucy-photo-"));
  const out = join(work, "photo.jpg");

  try {
    // Centre-crop to a square FIRST, then scale. The other order letterboxes a
    // non-square photo, and a contact avatar with bars down the side looks broken
    // rather than cropped.
    sips(["-c", String(edge), String(edge), "-Z", String(EDGE), "-s", "format", "jpeg", source, "--out", out]);

    const base64 = readFileSync(out).toString("base64");
    console.log(`${width}×${height} → ${EDGE}×${EDGE} JPEG, ${base64.length} base64 chars`);
    if (base64.length > WARN_BYTES) {
      console.warn(`⚠️  That's large for a contact card (${base64.length} chars).`);
    }

    const { error } = await supabase
      .from("channel_state")
      .upsert({ key: PHOTO_KEY, value: { base64, type: "JPEG" }, updated_at: new Date().toISOString() });
    if (error) throw new Error(error.message);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  // Prove it round-trips into a real card rather than just reporting a row write.
  const card = await buildVCard();
  const photoLines = card.split("\r\n").filter((l) => l.startsWith("PHOTO")).length;
  const folded = card.split("\r\n").filter((l) => l.startsWith(" ")).length;
  console.log(
    photoLines === 1
      ? `Stored. The card now carries the photo (${folded} folded continuation lines, ${card.length} bytes total).`
      : "Stored, but the card did NOT pick the photo up — check channel_state.",
  );
  console.log("It uploads itself on the next first-text; nothing else to do.");
}

const arg = process.argv[2];
const run = arg === "--clear" ? clear() : arg ? install(arg) : Promise.reject(new Error("usage: set-contact-photo.ts <image path> | --clear"));

run.catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
