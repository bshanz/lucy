import { defineSchedule } from "eve/schedules";
import type { ScheduleHandlerArgs } from "eve/schedules";
import sendblue, { sendblueAuth } from "#channels/sendblue.js";
import { fetchRecentInbound, messageKey } from "#lib/sendblue.js";
import { supabase } from "#lib/supabase.js";

/**
 * Free-sandbox ingress: Sendblue has no webhooks on the free tier, so this
 * poller is how the owner's texts reach Lucy.
 *
 * FAST-POLL: Vercel cron fires at most once a minute, but each invocation
 * loops for ~50s polling every 10s — effective reply latency ~10-20s instead
 * of ~60-90s, at no extra cost. Overlap with the next tick is harmless: the
 * atomic claim in processed_messages means only one poller wins each message.
 *
 * Correctness rules (borrowed from the help-bot gmail poller):
 *  - claim BEFORE dispatch (insert into processed_messages, ignore dupes),
 *    un-claim on dispatch failure — a crash loses one reply, never doubles.
 *  - one dispatch per pass per phone (batched) — two concurrent sends on the
 *    same continuation token race the park hook.
 *
 * `eve dev` never fires crons — trigger locally with
 * `curl -X POST http://localhost:3000/eve/v1/dev/schedules/sendblue-poll`.
 */

const PASSES = 5; // t = 0s, 10s, 20s, 30s, 40s — done well before the next tick
const PASS_INTERVAL_MS = 10_000;

async function pollOnce(receive: ScheduleHandlerArgs["receive"], owner: string): Promise<void> {
  const inbound = await fetchRecentInbound(25);

  // Only the owner, only recent (poll window safety net), oldest first.
  const cutoff = Date.now() - 15 * 60 * 1000;
  const candidates = inbound
    .filter((m) => m.from_number === owner)
    .filter((m) => m.content && m.content.trim().length > 0)
    .filter((m) => new Date(m.date_sent).getTime() > cutoff)
    .sort((a, b) => new Date(a.date_sent).getTime() - new Date(b.date_sent).getTime());

  if (candidates.length === 0) return;

  // Claim: insert keys, keep only rows that were actually new.
  const rows = candidates.map((m) => ({ message_id: messageKey(m) }));
  const { data: claimed, error } = await supabase
    .from("processed_messages")
    .upsert(rows, { onConflict: "message_id", ignoreDuplicates: true })
    .select("message_id");
  if (error) throw new Error(`[sendblue-poll] claim failed: ${error.message}`);

  const claimedIds = new Set((claimed ?? []).map((r) => r.message_id as string));
  const fresh = candidates.filter((m) => claimedIds.has(messageKey(m)));
  if (fresh.length === 0) return;

  const message =
    fresh.length === 1 ? fresh[0].content! : fresh.map((m) => m.content!.trim()).join("\n");

  console.log(`[sendblue-poll] dispatching ${fresh.length} message(s) from ${owner}`);
  try {
    await receive(sendblue, {
      message,
      target: { phone: owner },
      auth: sendblueAuth(owner),
    });
  } catch (err) {
    // Un-claim so a later pass retries.
    await supabase
      .from("processed_messages")
      .delete()
      .in("message_id", fresh.map(messageKey));
    throw err;
  }
}

export default defineSchedule({
  cron: "* * * * *",
  async run({ receive }) {
    const owner = process.env.OWNER_PHONE;
    if (!owner || !process.env.SENDBLUE_API_KEY_ID || !process.env.SUPABASE_SECRET_KEY) {
      console.warn("[sendblue-poll] OWNER_PHONE / Sendblue / Supabase env not set; skipping");
      return;
    }

    for (let pass = 0; pass < PASSES; pass++) {
      try {
        await pollOnce(receive, owner);
      } catch (err) {
        // One bad pass (transient API error) shouldn't kill the whole minute.
        console.error(`[sendblue-poll] pass ${pass} failed`, err);
      }
      if (pass < PASSES - 1) {
        await new Promise((r) => setTimeout(r, PASS_INTERVAL_MS));
      }
    }
  },
});
