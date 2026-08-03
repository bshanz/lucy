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
    const { data, error } = await supabase
      .from("reminders")
      .update({ status: "done", next_follow_up_at: null })
      .eq("id", id)
      .in("status", ["sent", "sending", "lapsed"])
      .select("id, body")
      .maybeSingle();
    if (error) return { ok: false as const, error: error.message };
    if (!data) return { ok: false as const, error: "No fired, unconfirmed reminder with that id" };
    return { ok: true as const, completed: data.body as string };
  },
});
