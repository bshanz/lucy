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

const LEASE_STALE_MS = 90_000;

/** Exactly the watch-mode lease resy-snipe.ts issues. Keep the two in step. */
async function lease(now: number) {
  const { data, error } = await supabase
    .from("resy_snipes")
    .update({ fired_at: new Date().toISOString() })
    .eq("status", "armed")
    .not("watch_from", "is", null)
    .lte("watch_from", new Date(now).toISOString())
    .gte("watch_until", new Date(now).toISOString())
    .or(`fired_at.is.null,fired_at.lt.${new Date(now - LEASE_STALE_MS).toISOString()}`)
    .select("id");
  if (error) throw new Error(error.message);
  return data ?? [];
}

async function seedWatch(from: Date, until: Date, firedAt: Date | null = null): Promise<string> {
  const { data, error } = await supabase
    .from("resy_snipes")
    .insert({
      channel: "imessage",
      phone: "+10000000000",
      venue_id: TEST_VENUE,
      venue_name: "Lease Test (not a real venue)",
      reservation_date: "2030-01-02",
      party_size: 2,
      earliest_time: "19:00",
      latest_time: "21:00",
      max_deposit_cents: 0,
      drop_at: null,
      watch_from: from.toISOString(),
      watch_until: until.toISOString(),
      fired_at: firedAt ? firedAt.toISOString() : null,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return data.id as string;
}

/**
 * Watch-mode rows are LEASED, not consumed.
 *
 * A watch spans hours across dozens of cron ticks, almost all of which see no
 * inventory. If an empty minute consumed the row the way a precise snipe does,
 * the snipe would die on its first tick and sit "missed" for hours while the
 * tables it was waiting for came and went. Equally, two workers holding the same
 * row at once could both reach /3/book — the exact double-booking the precise
 * path's claim exists to prevent. So: status stays 'armed', and `fired_at` is a
 * lease that expires.
 */
async function watchModeChecks(now: number): Promise<void> {
  // Two concurrent workers, one open watch window → exactly one lease.
  await seedWatch(new Date(now - 60_000), new Date(now + 600_000));
  const [x, y] = await Promise.all([lease(now), lease(now)]);
  check("two concurrent workers yield exactly one lease", x.length + y.length, 1);

  // The row must still be armed — a leased minute is not a spent snipe.
  const { data: still } = await supabase
    .from("resy_snipes")
    .select("status")
    .eq("venue_id", TEST_VENUE)
    .maybeSingle();
  check("a leased watch row stays 'armed'", still?.status, "armed");

  // Same minute, another worker: the lease is held, so nothing to take.
  check("a held lease blocks a second worker", (await lease(now)).length, 0);

  // Releasing (what runWatch does on an empty pass) frees it for the next tick.
  await supabase.from("resy_snipes").update({ fired_at: null }).eq("venue_id", TEST_VENUE);
  check("a released lease is re-takeable next tick", (await lease(now)).length, 1);
  await cleanup();

  // A worker that crashed mid-watch must not park the snipe forever.
  await seedWatch(new Date(now - 60_000), new Date(now + 600_000), new Date(now - LEASE_STALE_MS - 10_000));
  check("a stale lease is reclaimable", (await lease(now)).length, 1);
  await cleanup();

  // Windows bound the watching, in both directions.
  await seedWatch(new Date(now + 600_000), new Date(now + 1_200_000));
  check("a window that hasn't opened yet is not leased", (await lease(now)).length, 0);
  await cleanup();

  await seedWatch(new Date(now - 1_200_000), new Date(now - 600_000));
  check("a window that already closed is not leased", (await lease(now)).length, 0);
  await cleanup();

  // The schema must refuse an ambiguous row: both shapes, or neither.
  let bothRejected = false;
  try {
    await supabase
      .from("resy_snipes")
      .insert({
        channel: "imessage", phone: "+10000000000", venue_id: TEST_VENUE,
        venue_name: "Bad shape", reservation_date: "2030-01-03", party_size: 2,
        earliest_time: "19:00", latest_time: "21:00", max_deposit_cents: 0,
        drop_at: new Date(now + 60_000).toISOString(),
        watch_from: new Date(now).toISOString(),
        watch_until: new Date(now + 600_000).toISOString(),
      })
      .select("id")
      .single()
      .then((r) => { if (r.error) throw new Error(r.error.message); });
  } catch (err) {
    bothRejected = /resy_snipes_timing_shape|violates check/i.test(String(err));
  }
  check("a row with BOTH a drop time and a watch window is rejected", bothRejected, true);
  await cleanup();
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

  await watchModeChecks(now);
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
