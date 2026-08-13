/**
 * Checks that the scheduled-email claim cannot double-send.
 * Run with `npx tsx --env-file=.env.local scripts/check-email-claim.ts`.
 *
 * This is the single most important check in the scheduled-email feature, and it
 * exists as a script because the obvious way to test it — let two crons race a
 * real row — costs a real person two copies of the same email from the owner's
 * real address. There is no undo for that, so the property gets proved against
 * the database instead, with nothing leaving the machine.
 *
 * The claim under test is an `UPDATE ... WHERE status = 'scheduled' ...
 * RETURNING`. Postgres serialises the two updates and re-evaluates the WHERE
 * against the committed row, so the loser matches nothing and returns zero rows.
 * Reading the row and then writing it would NOT have this property.
 *
 * Touches only rows it creates, and deletes them on the way out. NO EMAIL IS
 * SENT: nothing here calls Gmail, and every test row is addressed into the
 * RFC 2606 `.invalid` TLD, which is guaranteed never to resolve — so even a
 * stray row that escaped cleanup and got picked up by a live cron could not
 * reach a person.
 */
import { STUCK_MS, supabase } from "#lib/scheduled-email.js";

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

const TEST_TO = "claim-test@claim-test.invalid";

/** Exactly the claim email-send.ts issues. Kept in sync by hand — change one, change both. */
async function claim() {
  const { data, error } = await supabase
    .from("scheduled_emails")
    .update({ status: "sending", claimed_at: new Date().toISOString() })
    .eq("status", "scheduled")
    .lte("send_at", new Date().toISOString())
    .select("id");
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** Exactly the orphan sweep email-send.ts issues. */
async function orphans() {
  const { data, error } = await supabase
    .from("scheduled_emails")
    .select("id")
    .eq("status", "sending")
    .lt("claimed_at", new Date(Date.now() - STUCK_MS).toISOString());
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** Exactly the guard cancel_scheduled_email.ts issues. */
async function cancel(id: string) {
  const { data, error } = await supabase
    .from("scheduled_emails")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "scheduled")
    .select("id");
  if (error) throw new Error(error.message);
  return data ?? [];
}

async function cleanup(): Promise<void> {
  await supabase.from("scheduled_emails").delete().eq("to_address", TEST_TO);
}

async function seed(sendAt: Date, fields: Record<string, unknown> = {}): Promise<string> {
  const { data, error } = await supabase
    .from("scheduled_emails")
    .insert({
      to_address: TEST_TO,
      subject: "Claim test — never sent",
      body: "This row exists to prove the claim works. It is never delivered.",
      send_at: sendAt.toISOString(),
      channel: "imessage",
      phone: "+10000000000",
      ...fields,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return data.id as string;
}

async function statusOf(id: string): Promise<string | undefined> {
  const { data } = await supabase.from("scheduled_emails").select("status").eq("id", id).maybeSingle();
  return data?.status as string | undefined;
}

async function main(): Promise<void> {
  await cleanup(); // in case a previous run died mid-flight

  const now = Date.now();

  // --- 1. THE test: two workers, one due row, one winner. A second winner here
  // is a real person receiving the same email twice.
  await seed(new Date(now - 30_000));
  const [a, b] = await Promise.all([claim(), claim()]);
  check("two concurrent claims yield exactly one winner", a.length + b.length, 1);
  await cleanup();

  // --- 2. The re-run case: eve retrying an interrupted step, not a concurrent
  // one. The retry must find nothing rather than send again.
  await seed(new Date(now - 30_000));
  check("first claim takes the row", (await claim()).length, 1);
  check("re-run of an interrupted step claims nothing", (await claim()).length, 0);
  await cleanup();

  // --- 3. A send time still in the future is left alone. Firing early is not a
  // near miss — the whole feature is that it goes out when he said.
  await seed(new Date(now + 600_000));
  check("an email not yet due is not claimed", (await claim()).length, 0);
  await cleanup();

  // --- 4. ...and one whose minute has arrived IS claimed, however late the cron
  // was. There is no grace window on purpose: a late email is still wanted, and
  // there is no equivalent of stale inventory to protect against.
  await seed(new Date(now - 6 * 3600_000));
  check("a long-overdue email is still claimed", (await claim()).length, 1);
  await cleanup();

  // --- 5. Cancelling is only meaningful if it actually stops the send. This is
  // the property the owner is relying on when he says "no, kill that one".
  const cancelled = await seed(new Date(now - 30_000));
  check("cancel takes a queued row", (await cancel(cancelled)).length, 1);
  check("a cancelled email is never claimed", (await claim()).length, 0);
  check("...and stays cancelled", await statusOf(cancelled), "cancelled");
  await cleanup();

  // --- 6. The other side of that guard: once a row is claimed it is on the
  // wire, and reporting it cancelled would be a lie about an email a real
  // person is about to receive.
  const inFlight = await seed(new Date(now - 30_000));
  await claim();
  check("an in-flight email cannot be cancelled", (await cancel(inFlight)).length, 0);
  check("...and is still 'sending'", await statusOf(inFlight), "sending");
  await cleanup();

  // --- 7. Orphan recovery must be patient. A row claimed seconds ago belongs to
  // a worker that is very likely still running; sweeping it would have a second
  // worker checking Sent for an email currently mid-flight.
  await seed(new Date(now - 30_000), {
    status: "sending",
    claimed_at: new Date(now - 5_000).toISOString(),
  });
  check("a freshly claimed row is not treated as orphaned", (await orphans()).length, 0);
  await cleanup();

  // --- 8. ...but a row claimed before any plausible invocation lifetime is one
  // whose worker died. It gets resolved against the Sent folder, never retried.
  await seed(new Date(now - 30_000), {
    status: "sending",
    claimed_at: new Date(now - STUCK_MS - 60_000).toISOString(),
  });
  check("a stale claim is picked up as orphaned", (await orphans()).length, 1);
  check("an orphaned row is not re-claimed by the normal path", (await claim()).length, 0);
  await cleanup();

  // --- 9. Terminal states stay terminal. A 'sent' row re-entering the claim is
  // the same duplicate-email failure as a lost race, arriving by a slower route.
  for (const status of ["sent", "failed", "cancelled"]) {
    await seed(new Date(now - 30_000), { status });
    check(`a '${status}' email is never claimed`, (await claim()).length, 0);
    await cleanup();
  }
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
