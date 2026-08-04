/**
 * Checks that the snipe claim cannot double-book.
 * Run with `npx tsx --env-file=.env.local scripts/check-resy-claim.ts`.
 *
 * This is the single most important check in the Resy feature. Vercel can
 * deliver a cron twice and eve re-runs interrupted steps, so resy-snipe's claim
 * has to be the thing that stops two workers racing the same row. If it doesn't,
 * the failure isn't a duplicate log line — it's two real reservations at the same
 * restaurant on the same night, two cancellation fees, and a Resy account
 * suspended for exactly the behaviour that looks like a bot.
 *
 * The claim under test is an `UPDATE ... WHERE status = 'armed' ... RETURNING`.
 * Postgres serialises the two updates and re-evaluates the WHERE against the
 * committed row, so the loser matches nothing and returns zero rows. Reading the
 * row and then writing it would NOT have this property.
 *
 * Touches only rows it creates, and deletes them on the way out. Spends nothing
 * with Resy — no network calls leave this script.
 */
import { supabase } from "#lib/supabase.js";

const LOOKAHEAD_MS = 90_000;
const GRACE_MS = 120_000;

let failures = 0;
function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    failures++;
    console.log(`FAIL  ${name}\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);
  } else {
    console.log(`PASS  ${name}`);
  }
}

/** Exactly the claim resy-snipe.ts issues. Kept in sync by hand — if you change one, change both. */
async function claim(now: number) {
  const { data, error } = await supabase
    .from("resy_snipes")
    .update({ status: "firing", fired_at: new Date().toISOString() })
    .eq("status", "armed")
    .gte("drop_at", new Date(now - GRACE_MS).toISOString())
    .lte("drop_at", new Date(now + LOOKAHEAD_MS).toISOString())
    .select("id");
  if (error) throw new Error(error.message);
  return data ?? [];
}

// A venue id no real restaurant uses, so a stray row is obvious and can never
// collide with a genuine snipe the owner has armed.
const TEST_VENUE = 999_999_999;

async function cleanup(): Promise<void> {
  await supabase.from("resy_snipes").delete().eq("venue_id", TEST_VENUE);
}

async function seed(dropAt: Date): Promise<string> {
  const { data, error } = await supabase
    .from("resy_snipes")
    .insert({
      channel: "imessage",
      phone: "+10000000000",
      venue_id: TEST_VENUE,
      venue_name: "Claim Test (not a real venue)",
      reservation_date: "2030-01-01",
      party_size: 2,
      earliest_time: "19:00",
      latest_time: "21:00",
      max_deposit_cents: 0,
      drop_at: dropAt.toISOString(),
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return data.id as string;
}

async function main(): Promise<void> {
  await cleanup(); // in case a previous run died mid-flight

  const now = Date.now();

  // --- 1. THE test: two workers, one row, one winner.
  await seed(new Date(now + 30_000));
  const [a, b] = await Promise.all([claim(now), claim(now)]);
  const winners = a.length + b.length;
  check("two concurrent claims yield exactly one winner", winners, 1);
  await cleanup();

  // --- 2. A third pass over an already-claimed row must find nothing. This is
  // the re-run case: eve retrying an interrupted step, not a concurrent one.
  await seed(new Date(now + 30_000));
  const first = await claim(now);
  const second = await claim(now);
  check("first claim takes the row", first.length, 1);
  check("re-run of an interrupted step claims nothing", second.length, 0);
  await cleanup();

  // --- 3. Window boundaries. A snipe further out than the lookahead must be
  // left alone, or it fires early against inventory that doesn't exist yet.
  await seed(new Date(now + LOOKAHEAD_MS + 60_000));
  check("a drop beyond the lookahead is not claimed", (await claim(now)).length, 0);
  await cleanup();

  // --- 4. ...but one that just passed IS still claimed. Cron delay is normal
  // and tables linger for a moment; giving up here loses winnable tables.
  await seed(new Date(now - 30_000));
  check("a drop inside the grace window is still claimed", (await claim(now)).length, 1);
  await cleanup();

  // --- 5. A drop long past is abandoned rather than fired at stale inventory.
  await seed(new Date(now - GRACE_MS - 60_000));
  check("a long-past drop is not claimed", (await claim(now)).length, 0);
  await cleanup();

  // --- 6. The partial unique index has to stop a second armed snipe for the
  // same table — that's a double booking arranged in advance.
  await seed(new Date(now + 30_000));
  let duplicateRejected = false;
  try {
    await seed(new Date(now + 30_000));
  } catch (err) {
    duplicateRejected = /duplicate key|23505/i.test(String(err));
  }
  check("a duplicate armed snipe for the same table is rejected", duplicateRejected, true);
  await cleanup();

  // --- 7. ...while a finished snipe must NOT block re-arming the same venue
  // and night later. A partial index is the whole reason this works.
  const doneId = await seed(new Date(now + 30_000));
  await supabase.from("resy_snipes").update({ status: "missed" }).eq("id", doneId);
  let reArmed = true;
  try {
    await seed(new Date(now + 30_000));
  } catch {
    reArmed = false;
  }
  check("a finished snipe does not block re-arming the same table", reArmed, true);
  await cleanup();
}

main()
  .then(async () => {
    await cleanup();
    console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} FAILED`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch(async (err) => {
    await cleanup().catch(() => {});
    console.error("\nCheck script itself failed:", err);
    process.exit(1);
  });
