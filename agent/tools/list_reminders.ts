import { defineTool } from "eve/tools";
import { z } from "zod";
import { formatLocal, supabase } from "#lib/reminders.js";

export default defineTool({
  description:
    "List the owner's reminders. filter 'upcoming' (default) = not yet fired; " +
    "'awaiting_confirmation' = fired but the owner hasn't confirmed doing them (use these ids " +
    "with complete_reminder / reschedule_reminder); 'all' = both. Awaiting-confirmation " +
    "includes ones that ran out of follow-up nudges — those are still open and still his to " +
    "close, you just don't bring them up unprompted anymore.",
  inputSchema: z.object({
    filter: z.enum(["upcoming", "awaiting_confirmation", "all"]).optional(),
  }),
  async execute({ filter }) {
    const statuses =
      filter === "awaiting_confirmation"
        ? ["sent", "lapsed"]
        : filter === "all"
          ? ["pending", "sent", "lapsed"]
          : ["pending"];
    const { data, error } = await supabase
      .from("reminders")
      .select("id, body, fire_at, recurrence, channel, status, sent_at")
      .in("status", statuses)
      .order("fire_at", { ascending: true })
      .limit(50);
    if (error) return { ok: false as const, error: error.message };

    return {
      ok: true as const,
      reminders: (data ?? []).map((r) => ({
        id: r.id as string,
        body: r.body as string,
        localTime: formatLocal(r.fire_at as string),
        recurrence: (r.recurrence as string | null) ?? "one-off",
        channel: r.channel as string,
        state:
          r.status === "sent"
            ? "fired, awaiting confirmation"
            : r.status === "lapsed"
              ? "fired, still unconfirmed — no longer nudging about it"
              : "upcoming",
      })),
    };
  },
});
