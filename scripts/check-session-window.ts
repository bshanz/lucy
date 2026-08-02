/**
 * Checks the iMessage conversation-window rotation. Run with
 * `npx tsx scripts/check-session-window.ts`.
 *
 * This sits directly in the messaging path: rotate at the wrong moment and the
 * owner's reply is answered by a session that never saw the question, or a
 * pending approval is stranded with no way to answer it. Uses a throwaway phone
 * number against the real channel_state table and cleans up after itself.
 */
import { sessionToken } from "#channels/sendblue.js";
import { supabase } from "#lib/supabase.js";

const PHONE = "+15550000199"; // never a real Sendblue line
const sessionKey = `sendblue:session:${PHONE}`;
const pendingKey = `sendblue:pending_input:${PHONE}`;

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

let failures = 0;
function check(name: string, got: string, want: string) {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} → ${got}${ok ? "" : ` (wanted ${want})`}`);
}

async function setWindow(epoch: number, ageMs: number, idleMs: number) {
  const now = Date.now();
  await supabase.from("channel_state").upsert(
    [{
      key: sessionKey,
      value: {
        epoch,
        startedAt: new Date(now - ageMs).toISOString(),
        lastActivityAt: new Date(now - idleMs).toISOString(),
      },
      updated_at: new Date().toISOString(),
    }],
    { onConflict: "key" },
  );
}

async function reset() {
  await supabase.from("channel_state").delete().in("key", [sessionKey, pendingKey]);
}

await reset();

// 1. Cold start adopts the bare phone number, so a session already running when
//    this shipped is continued rather than abandoned.
check("no window yet", await sessionToken(PHONE), PHONE);

// 2. Young window: nothing to do.
await setWindow(0, 1 * DAY, 5 * HOUR);
check("window 1d old, idle 5h", await sessionToken(PHONE), PHONE);

// 3. THE mid-thread guard: old enough to rotate, but the conversation is live.
await setWindow(0, 30 * DAY, 10 * 60 * 1000);
check("30d old but idle only 10m", await sessionToken(PHONE), PHONE);

// 4. Old AND quiet: rotate.
await setWindow(0, 30 * DAY, 6 * HOUR);
check("30d old, idle 6h", await sessionToken(PHONE), `${PHONE}#1`);

// 5. Rotation is sticky — the next message stays in the new window.
check("subsequent message", await sessionToken(PHONE), `${PHONE}#1`);

// 6. A stranded approval is worse than a long session: never rotate past one.
await setWindow(1, 30 * DAY, 6 * HOUR);
await supabase.from("channel_state").upsert(
  [{
    key: pendingKey,
    value: { requests: [{ requestId: "req_1", options: [{ id: "approve", label: "Approve" }] }] },
    updated_at: new Date().toISOString(),
  }],
  { onConflict: "key" },
);
check("due to rotate, approval pending", await sessionToken(PHONE), `${PHONE}#1`);
await supabase.from("channel_state").delete().eq("key", pendingKey);

// 7. Read-only lookups must never move the window.
await setWindow(1, 30 * DAY, 6 * HOUR);
check("rotate:false on a due window", await sessionToken(PHONE, { rotate: false }), `${PHONE}#1`);
check("...and it did not rotate", await sessionToken(PHONE, { rotate: false }), `${PHONE}#1`);

await reset();
console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
