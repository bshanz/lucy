import { defineTool } from "eve/tools";
import { z } from "zod";
import { formatLocal, primeOwnerTimezone } from "#lib/reminders.js";
import { supabase } from "#lib/scheduled-email.js";

export default defineTool({
  description:
    "List emails the owner has approved that haven't gone out yet. filter 'queued' (default) = " +
    "still waiting; 'recent' = queued plus anything sent or failed in the last week, which is " +
    "how you answer 'did that ever go?'. Use the ids with cancel_scheduled_email.",
  inputSchema: z.object({
    filter: z.enum(["queued", "recent"]).optional(),
  }),
  async execute({ filter }) {
    // Tools run in their own workflow step, not in the invocation that primed
    // the zone at ingress, so the cache is cold here. See primeOwnerTimezone.
    await primeOwnerTimezone();
    const query = supabase
      .from("scheduled_emails")
      .select("id, to_address, subject, body, send_at, status, sent_at, last_error")
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
      emails: (data ?? []).map((e) => ({
        id: e.id as string,
        to: e.to_address as string,
        subject: e.subject as string,
        // A preview, not the body. He asked what's queued, not to re-read four
        // emails, and dumping them all costs context every time he checks.
        preview: (e.body as string).replace(/\s+/g, " ").slice(0, 120),
        localTime: formatLocal(e.send_at as string),
        state:
          e.status === "scheduled"
            ? "queued"
            : e.status === "sending"
              ? "going out right now — too late to cancel"
              : e.status === "sent"
                ? "sent"
                : `didn't send: ${e.last_error ?? "unknown error"}`,
      })),
    };
  },
});
