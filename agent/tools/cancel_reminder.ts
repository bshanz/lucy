import { defineTool } from "eve/tools";
import { z } from "zod";
import { supabase } from "#lib/reminders.js";

export default defineTool({
  description:
    "Cancel a pending reminder by id (get ids from list_reminders). Also stops a recurring reminder for good.",
  inputSchema: z.object({
    id: z.string().uuid().describe("The reminder id to cancel"),
  }),
  async execute({ id }) {
    const { data, error } = await supabase
      .from("reminders")
      .update({ status: "cancelled" })
      .eq("id", id)
      .eq("status", "pending")
      .select("id, body")
      .maybeSingle();
    if (error) return { ok: false as const, error: error.message };
    if (!data) return { ok: false as const, error: "No pending reminder with that id" };
    return { ok: true as const, cancelled: data.body as string };
  },
});
