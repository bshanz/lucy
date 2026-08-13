import { defineTool } from "eve/tools";
import { z } from "zod";
import { supabase } from "#lib/scheduled-email.js";

export default defineTool({
  description:
    "Drop a queued email before it sends (get ids from list_scheduled_emails). Use this whenever " +
    "the owner changes his mind, wants different wording, or wants a different time — for new " +
    "wording, cancel and schedule a fresh one, since the approved text can't be edited in place. " +
    "This cannot recall an email that has already gone out.",
  inputSchema: z.object({
    id: z.string().uuid().describe("The scheduled email id to cancel"),
  }),
  async execute({ id }) {
    const { data, error } = await supabase
      .from("scheduled_emails")
      .update({ status: "cancelled", updated_at: new Date().toISOString() })
      .eq("id", id)
      // Deliberately NOT 'sending': that status is the poll's in-flight claim,
      // and it will write its own result over anything set underneath it. A
      // 'sending' row is already on the wire — telling the owner it was cancelled
      // would be a lie about an email a real person is about to receive.
      .eq("status", "scheduled")
      .select("id, to_address, subject")
      .maybeSingle();
    if (error) return { ok: false as const, error: error.message };
    if (!data) {
      return {
        ok: false as const,
        error:
          "Nothing queued with that id — it's already sent, already cancelled, or going out " +
          "right now. Check list_scheduled_emails with filter 'recent' before telling him " +
          "anything about whether it went.",
      };
    }
    return {
      ok: true as const,
      cancelled: { to: data.to_address as string, subject: data.subject as string },
    };
  },
});
