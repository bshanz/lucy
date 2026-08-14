/**
 * Checks that the outbound-text claim cannot double-send, that normalizePhone
 * refuses rather than guesses, and that the pre-card checks let through exactly
 * the messages that are safe to show the owner and send unchanged.
 *
 * Run with `npx tsx --env-file=.env.local scripts/check-text-claim.ts`.
 *
 * This is the single most important check in the feature, and it exists as a
 * script because the obvious way to test it — let two crons race a real row —
 * costs a real person two copies of the same text under the owner's name. There
 * is no undo for that, so the property gets proved against the database instead,
 * with nothing leaving the machine.
 *
 * The claim under test is an `UPDATE ... WHERE status = 'scheduled' ...
 * RETURNING`. Postgres serialises the two updates and re-evaluates the WHERE
 * against the committed row, so the loser matches nothing and returns zero rows.
 * Reading the row and then writing it would NOT have this property.
 *
 * Touches only rows it creates, and deletes them on the way out. NOTHING IS SENT:
 * nothing here calls Sendblue, and every test row is addressed to +1 555 0100,
 * which is inside the 555-0100..555-0199 block reserved for fiction and assigned
 * to nobody — so even a stray row that escaped cleanup and got picked up by a live
 * cron could not reach a person.
 */
import {
  STUCK_MS,
  autoReplyText,
  explainSendFailure,
  hasAutoReplied,
  introLine,
  markAutoReplied,
  normalizePhone,
  preflight,
  supabase,
} from "#lib/outbound-text.js";

let failures = 0;
function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    failures++;
    console.log(
      `FAIL  ${name}\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`,
    );
  } else {
    console.log(`PASS  ${name}`);
  }
}

const TEST_TO = "+15555550100";

/** Exactly the claim text-send.ts issues. Kept in sync by hand — change one, change both. */
async function claim() {
  const { data, error } = await supabase
    .from("outbound_texts")
    .update({ status: "sending", claimed_at: new Date().toISOString() })
    .eq("status", "scheduled")
    .lte("send_at", new Date().toISOString())
    .select("id");
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** Exactly the orphan sweep text-send.ts issues. */
async function orphans() {
  const { data, error } = await supabase
    .from("outbound_texts")
    .select("id")
    .eq("status", "sending")
    .lt("claimed_at", new Date(Date.now() - STUCK_MS).toISOString());
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** Exactly the gate text-replies.ts issues before relaying or acknowledging anything. */
async function allowedToRelay(senders: string[]): Promise<string[]> {
  const { data, error } = await supabase
    .from("outbound_texts")
    .select("to_number")
    .in("to_number", senders)
    .eq("status", "sent");
  if (error) throw new Error(error.message);
  return [...new Set((data ?? []).map((r) => r.to_number as string))];
}

/** Exactly the guard cancel_scheduled_text.ts issues. */
async function cancel(id: string) {
  const { data, error } = await supabase
    .from("outbound_texts")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "scheduled")
    .select("id");
  if (error) throw new Error(error.message);
  return data ?? [];
}

async function cleanup(): Promise<void> {
  await supabase.from("outbound_texts").delete().eq("to_number", TEST_TO);
}

async function seed(sendAt: Date, fields: Record<string, unknown> = {}): Promise<string> {
  const { data, error } = await supabase
    .from("outbound_texts")
    .insert({
      to_number: TEST_TO,
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
  const { data } = await supabase
    .from("outbound_texts")
    .select("status")
    .eq("id", id)
    .maybeSingle();
  return data?.status as string | undefined;
}

async function main(): Promise<void> {
  await cleanup(); // in case a previous run died mid-flight

  const now = Date.now();

  // --- 1. THE test: two workers, one due row, one winner. A second winner here
  // is a real person receiving the same text twice.
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
  check("a text not yet due is not claimed", (await claim()).length, 0);
  await cleanup();

  // --- 4. ...and one whose minute has arrived IS claimed, however late the cron
  // was. No grace window: a late text is still wanted.
  await seed(new Date(now - 6 * 3600_000));
  check("a long-overdue text is still claimed", (await claim()).length, 1);
  await cleanup();

  // --- 5. Cancelling is only meaningful if it actually stops the send. This is
  // the property the owner is relying on when he says "no, kill that one".
  const cancelled = await seed(new Date(now - 30_000));
  check("cancel takes a queued row", (await cancel(cancelled)).length, 1);
  check("a cancelled text is never claimed", (await claim()).length, 0);
  check("...and stays cancelled", await statusOf(cancelled), "cancelled");
  await cleanup();

  // --- 6. The other side of that guard: once a row is claimed it is on the wire,
  // and reporting it cancelled would be a lie about a message a real person is
  // about to receive.
  const inFlight = await seed(new Date(now - 30_000));
  await claim();
  check("an in-flight text cannot be cancelled", (await cancel(inFlight)).length, 0);
  check("...and is still 'sending'", await statusOf(inFlight), "sending");
  await cleanup();

  // --- 7. Orphan recovery must be patient. A row claimed seconds ago belongs to a
  // worker that is very likely still running.
  await seed(new Date(now - 30_000), {
    status: "sending",
    claimed_at: new Date(now - 5_000).toISOString(),
  });
  check("a freshly claimed row is not treated as orphaned", (await orphans()).length, 0);
  await cleanup();

  // --- 8. ...but a row claimed before any plausible invocation lifetime is one
  // whose worker died. It gets resolved against Sendblue, never retried.
  await seed(new Date(now - 30_000), {
    status: "sending",
    claimed_at: new Date(now - STUCK_MS - 60_000).toISOString(),
  });
  check("a stale claim is picked up as orphaned", (await orphans()).length, 1);
  check("an orphaned row is not re-claimed by the normal path", (await claim()).length, 0);
  await cleanup();

  // --- 9. Terminal states stay terminal. A 'sent' row re-entering the claim is
  // the same duplicate-text failure as a lost race, arriving by a slower route.
  for (const status of ["sent", "failed", "cancelled"]) {
    await seed(new Date(now - 30_000), { status });
    check(`a '${status}' text is never claimed`, (await claim()).length, 0);
    await cleanup();
  }

  // --- 10. Recipient normalisation. Pure, no database. The failure mode being
  // guarded is not a crash: it is a ten-digit number silently acquiring the wrong
  // country code and reaching whoever holds it there.
  const savedOwner = process.env.OWNER_PHONE;

  process.env.OWNER_PHONE = "+15551230000";
  check("E.164 passes through", normalizePhone("+15551234567"), "+15551234567");
  check("punctuation is stripped", normalizePhone("(555) 123-4567"), "+15551234567");
  check("a leading 1 is understood", normalizePhone("1-555-123-4567"), "+15551234567");
  check("a foreign E.164 number is kept as-is", normalizePhone("+442079460958"), "+442079460958");
  check("gibberish is refused", normalizePhone("call alex"), null);
  check("too few digits is refused", normalizePhone("+1234"), null);
  check("too many digits is refused", normalizePhone("+1234567890123456"), null);

  // The one that matters: outside NANP, bare local digits are ambiguous, and
  // guessing means picking a country for a stranger's phone.
  process.env.OWNER_PHONE = "+442079460958";
  check("a bare 10-digit number is refused for a non-NANP owner", normalizePhone("2079460958"), null);
  check("...while explicit E.164 still works", normalizePhone("+442079460958"), "+442079460958");

  if (savedOwner === undefined) delete process.env.OWNER_PHONE;
  else process.env.OWNER_PHONE = savedOwner;

  // --- 11. The pre-card checks. These run from the `approval` policy, so what
  // they let through is exactly what the owner is shown AND exactly what is sent;
  // there is no later stage that could quietly differ from either.
  const savedName = process.env.OWNER_NAME;
  process.env.OWNER_NAME = "Test Owner";
  process.env.OWNER_PHONE = "+15551230000";
  const intro = introLine();
  check("the intro line is built from OWNER_NAME's first name", intro, "Hey, it's Test — this is my assistant's number.");

  const said = (r: string | null) => (r === null ? "allowed" : r.slice(0, 24));

  // The owner's own number, in any formatting, is not a recipient for these tools.
  check("texting the owner is refused", said(await preflight("+15551230000", `${intro} hi`, true)), "That's the owner's own n");

  // Markdown is refused rather than silently stripped: stripping would mean the
  // card and the wire disagree, which is the one thing this feature can't do.
  check(
    "markdown is refused, not rewritten",
    said(await preflight(TEST_TO, `${intro} see **this**`, true)),
    "That message contains ma",
  );

  // First contact must introduce him, and must do it in the exact words — a
  // reworded intro is the model composing, which is what the check exists to stop.
  check("a first text without the intro is refused", said(await preflight(TEST_TO, "running late", true)), "This is the first text t");
  check(
    "a first text with a reworded intro is refused",
    said(await preflight(TEST_TO, "Hi, it's Test here! running late", true)),
    "This is the first text t",
  );
  check("a first text with the exact intro is allowed", said(await preflight(TEST_TO, `${intro} running late`, true)), "allowed");

  // ...and once a text has actually landed, the intro must NOT keep appearing.
  // Only 'sent' counts: a queued or failed row is a message nobody has read.
  await seed(new Date(now - 30_000), { status: "scheduled" });
  check("a queued text is not treated as prior contact", said(await preflight(TEST_TO, "hey", true)), "This is the first text t");
  await cleanup();

  await seed(new Date(now - 30_000), { status: "failed" });
  check("a failed text is not treated as prior contact", said(await preflight(TEST_TO, "hey", true)), "This is the first text t");
  await cleanup();

  check(
    "a first text without the contact card is refused",
    said(await preflight(TEST_TO, `${intro} running late`, false)),
    "This is the first text t",
  );

  await seed(new Date(now - 30_000), { status: "sent" });
  check("after a sent text, a bare message is allowed", said(await preflight(TEST_TO, "hey", false)), "allowed");
  // The other direction: the card is an introduction, not a signature. Re-sending
  // a vCard on every message is how someone ends up muting the number.
  check(
    "re-attaching the card to a known contact is refused",
    said(await preflight(TEST_TO, "hey", true)),
    "Don't attach the contact",
  );
  await cleanup();

  // --- 12. The failure explainer. The unverified-contact wording is matched
  // against the string the LIVE API actually returns, captured by POSTing to a
  // number that is not a contact:
  //   HTTP 400 {"status":"ERROR","error_message":"This contact must be verified
  //             before sending messages to it."}
  // If Sendblue rewords it, this check is what notices — a loose regex over an
  // error nobody has read is exactly how a wrong diagnosis gets shipped.
  const live = new Error(
    'Sendblue send failed (400): {"status":"ERROR","error_message":"This contact must be ' +
      'verified before sending messages to it."}',
  );
  check(
    "the live unverified-contact error is explained, not echoed",
    explainSendFailure(live, TEST_TO).startsWith("Sendblue won't deliver to"),
    true,
  );
  check(
    "...and the explanation says adding a contact is not enough",
    explainSendFailure(live, TEST_TO).includes("does NOT count"),
    true,
  );
  check(
    "an unrelated failure is passed through verbatim",
    explainSendFailure(new Error("socket hang up"), TEST_TO),
    "socket hang up",
  );

  // --- 13. The relay gate. The assistant's number is on a contact card in other
  // people's phones, so "someone texted the line" is not on its own a reason to
  // answer them or to interrupt the owner. Only people he has actually texted.
  process.env.OWNER_NAME = "Test Owner";
  check(
    "the auto-reply is a constant, built only from OWNER_NAME",
    autoReplyText(),
    "This is Test Owner's assistant — I've passed that along. I don't reply from this number.",
  );
  check("...and names no pronoun for the owner", /\b(he|him|his|she|her|they|them)\b/i.test(autoReplyText()), false);

  const STRANGER = "+15555550199";
  await supabase.from("outbound_texts").delete().eq("to_number", STRANGER);

  check("a number he has never texted is not relayed", await allowedToRelay([TEST_TO, STRANGER]), []);

  await seed(new Date(now - 30_000), { status: "scheduled" });
  check("a number with only a QUEUED text is not relayed", await allowedToRelay([TEST_TO]), []);
  await cleanup();

  await seed(new Date(now - 30_000), { status: "failed" });
  check("a number whose only text FAILED is not relayed", await allowedToRelay([TEST_TO]), []);
  await cleanup();

  await seed(new Date(now - 30_000), { status: "sent" });
  check("a number he has actually texted is relayed", await allowedToRelay([TEST_TO]), [TEST_TO]);
  check("...and a stranger alongside it still isn't", await allowedToRelay([TEST_TO, STRANGER]), [TEST_TO]);
  await cleanup();

  // The acknowledgement is once per person, forever — guarded by its own key so a
  // retried relay can never re-send it.
  await supabase.from("channel_state").delete().eq("key", `text_autoreply:${TEST_TO}`);
  check("a new contact has not been acknowledged", await hasAutoReplied(TEST_TO), false);
  await markAutoReplied(TEST_TO);
  check("...and is not acknowledged twice", await hasAutoReplied(TEST_TO), true);
  await supabase.from("channel_state").delete().eq("key", `text_autoreply:${TEST_TO}`);

  if (savedName === undefined) delete process.env.OWNER_NAME;
  else process.env.OWNER_NAME = savedName;
  if (savedOwner === undefined) delete process.env.OWNER_PHONE;
  else process.env.OWNER_PHONE = savedOwner;
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
