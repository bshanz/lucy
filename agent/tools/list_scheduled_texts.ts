import { defineTool } from "eve/tools";
import { z } from "zod";
import { supabase } from "#lib/outbound-text.js";
import { formatLocal } from "#lib/reminders.js";

export default defineTool({
  description:
    "List texts to other people that the owner has approved but that haven't gone out yet. " +
    "filter 'queued' (default) = still waiting; 'recent' = queued plus anything sent or failed " +
    "in the last week, which is how you answer 'did that ever go?'. Use the ids with " +
    "cancel_scheduled_text.",
  inputSchema: z.object({
    filter: z.enum(["queued", "recent"]).optional(),
  }),
  async execute({ filter }) {
    const query = supabase
      .from("outbound_texts")
      .select("id, to_number, body, send_at, status, sent_at, last_error")
      .order("send_at", { ascending: true })
      .limit(50);

    const { data, error } =
      filter === "recent"
        ? await query
            .in("status", ["scheduled", "sending", "sent", "failed"])
            .gte("send_at", new Date(Date.now() - 7 * 86400_000).toISOString())
        : await query.in("status", ["scheduled", "sending"]);
    if (error) return { ok: false as const, error: error.message };

    return {
      ok: true as const,
      texts: (data ?? []).map((t) => ({
        id: t.id as string,
        to: t.to_number as string,
        // A preview, not the whole message. He asked what's queued, not to re-read
        // four texts, and dumping them all costs context every time he checks.
        preview: (t.body as string).replace(/\s+/g, " ").slice(0, 120),
        localTime: formatLocal(t.send_at as string),
        state:
          t.status === "scheduled"
            ? "queued"
            : t.status === "sending"
              ? "going out right now — too late to cancel"
              : t.status === "sent"
                ? "sent"
                : `didn't send: ${t.last_error ?? "unknown error"}`,
      })),
    };
  },
});
