/**
 * Checks the pending-approval store's merge rules. Run with
 * `npx tsx --env-file=.env.local scripts/check-pending-store.ts`.
 *
 * The rules exist because of 2026-09-13: a second approval for the same
 * reply_to_email call overwrote the first in this store, the owner's "1"
 * answered only the survivor, and the orphaned request kept the session
 * parking after every tool step for two days. Uses a throwaway phone number
 * against the real channel_state table and cleans up after itself.
 */
import {
  mergePendingRequests,
  readPendingRequests,
  removePendingRequests,
  stableJson,
  writePendingRequests,
  type PendingRequest,
} from "#channels/sendblue.js";

const PHONE = "+15550000198"; // never a real Sendblue line
const opts = [{ id: "approve", label: "Yes" }, { id: "cancel", label: "No" }];
const email = (id: string, body: string): PendingRequest => ({
  requestId: id,
  options: opts,
  kind: "tool-approval",
  fingerprint: `reply_to_email:${stableJson({ threadId: "t1", body })}`,
  raisedAt: new Date().toISOString(),
});

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
const ids = (rs: PendingRequest[]) => rs.map((r) => `${r.requestId}${r.superseded ? "*" : ""}`).sort().join(",");

await writePendingRequests(PHONE, []);

// 1. Key order must not change the fingerprint: the same call is the same call.
check("stableJson is key-order independent", stableJson({ b: 1, a: [2, { d: 1, c: 2 }] }) === stableJson({ a: [2, { c: 2, d: 1 }], b: 1 }));

// 2. First request lands.
await mergePendingRequests(PHONE, [email("A", "hi")]);
check("first request stored", ids(await readPendingRequests(PHONE)) === "A");

// 3. The same action raised again supersedes the elder instead of replacing it silently.
await mergePendingRequests(PHONE, [email("B", "hi")]);
check("duplicate action supersedes the elder", ids(await readPendingRequests(PHONE)) === "A*,B", ids(await readPendingRequests(PHONE)));

// 4. A different action is kept alongside, untouched.
await mergePendingRequests(PHONE, [email("C", "different")]);
check("distinct action coexists", ids(await readPendingRequests(PHONE)) === "A*,B,C", ids(await readPendingRequests(PHONE)));

// 5. Re-raising an id already stored (eve re-rendering) does not duplicate it.
await mergePendingRequests(PHONE, [email("C", "different")]);
check("re-raised id is not duplicated", ids(await readPendingRequests(PHONE)) === "A*,B,C", ids(await readPendingRequests(PHONE)));

// 6. Answering removes only what was answered; the rest waits for the sweep.
await removePendingRequests(PHONE, ["B"]);
check("answered request removed, others kept", ids(await readPendingRequests(PHONE)) === "A*,C", ids(await readPendingRequests(PHONE)));

// 7. Removing the last one deletes the row rather than leaving an empty list.
await removePendingRequests(PHONE, ["A", "C"]);
check("empty store deletes the row", (await readPendingRequests(PHONE)).length === 0);

await writePendingRequests(PHONE, []);
console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
