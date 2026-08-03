import { defineTool } from "eve/tools";
import { z } from "zod";
import { supabase } from "#lib/reminders.js";

export default defineTool({
  description:
    "Drop a reminder by id (get ids from list_reminders) — one that hasn't fired yet, or one " +
    "that fired and the owner now wants off his list without having done it ('forget it', " +
    "'not doing that'). Also stops a recurring reminder for good. Use complete_reminder " +
    "instead when he actually did the thing.",
  inputSchema: z.object({
    id: z.string().uuid().describe("The reminder id to cancel"),
  }),
  async execute({ id }) {
    const { data, error } = await supabase
      .from("reminders")
      .update({ status: "cancelled", next_follow_up_at: null })
      .eq("id", id)
      // Not 'sending': that status is the poll's in-flight claim, and it will
      // write its own result over anything set underneath it.
      .in("status", ["pending", "sent", "lapsed"])
      .select("id, body")
      .maybeSingle();
    if (error) return { ok: false as const, error: error.message };
    if (!data) return { ok: false as const, error: "No active reminder with that id" };
    return { ok: true as const, cancelled: data.body as string };
  },
});
