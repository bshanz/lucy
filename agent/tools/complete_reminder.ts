import { defineTool } from "eve/tools";
import { z } from "zod";
import { supabase } from "#lib/reminders.js";

export default defineTool({
  description:
    "Mark a fired reminder as DONE — the owner confirmed they did the thing. Use when they say " +
    "'did it', 'done', 'yes I booked it', etc. Get ids from list_reminders (status " +
    "'awaiting_confirmation' shows fired-but-unconfirmed reminders).",
  inputSchema: z.object({
    id: z.string().uuid().describe("The reminder id to mark done"),
  }),
  async execute({ id }) {
    // A recurring reminder has no "done" state to reach, and letting one arrive
    // there kills the series silently. `status` is the only thing keeping it
    // alive — reminder-poll's due query is `status = 'pending'` — and the poll
    // rolls a recurring row back to 'pending' itself once a delivery confirms.
    // But that confirmation lags the message by up to the 2-minute delivery
    // grace window, and 'awaiting_delivery' is accepted below. So a tapback
    // answered promptly (the normal case for a check-in that asks a question)
    // lands mid-window, sets 'done', and the next occurrence simply never
    // arrives. Nothing errors and nothing logs: the failure looks exactly like
    // a working reminder that stopped being scheduled.
    const { data: existing, error: lookupError } = await supabase
      .from("reminders")
      .select("recurrence")
      .eq("id", id)
      .maybeSingle();
    if (lookupError) return { ok: false as const, error: lookupError.message };
    if (existing?.recurrence) {
      return {
        ok: false as const,
        error:
          `That reminder repeats (${existing.recurrence}) — there is nothing to complete, and ` +
          "no reply of his ever needs you to. It rolls forward to its next occurrence on its " +
          "own. If he answered a recurring check-in, the answer belongs in log_moment; if he " +
          "wants the series to stop, that's cancel_reminder.",
      };
    }

    const { data, error } = await supabase
      .from("reminders")
      .update({ status: "done", next_follow_up_at: null })
      .eq("id", id)
      .in("status", ["awaiting_delivery", "sent", "sending", "lapsed"])
      .select("id, body")
      .maybeSingle();
    if (error) return { ok: false as const, error: error.message };
    if (!data) return { ok: false as const, error: "No fired, unconfirmed reminder with that id" };
    return { ok: true as const, completed: data.body as string };
  },
});
