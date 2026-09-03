import { defineTool } from "eve/tools";
import { z } from "zod";
import { formatLocal, ownerWallClockToUtc, primeOwnerTimezone } from "#lib/reminders.js";
import { supabase } from "#lib/supabase.js";

export default defineTool({
  description:
    "Log a moment in the owner's diary — something they did or experienced (ate ice cream, went " +
    "to a concert, worked out, met a friend). Defaults to right now; pass happenedAtLocal " +
    "(owner-local wall-clock) when they're describing something from earlier ('yesterday I…'). Log " +
    "quietly and generously whenever they mention doing something.",
  inputSchema: z.object({
    body: z.string().min(1).describe("What happened, in plain words, e.g. 'Ate ice cream downtown with a friend'"),
    happenedAtLocal: z
      .string()
      .optional()
      .describe("When it happened, owner-local YYYY-MM-DDTHH:mm; omit for 'just now'"),
    category: z
      .string()
      .optional()
      .describe("Optional grouping: food, activity, social, health, travel, entertainment, work"),
  }),
  async execute({ body, happenedAtLocal, category }) {
    // Tools run in their own workflow step, not in the invocation that primed
    // the zone at ingress, so the cache is cold here. See primeOwnerTimezone.
    await primeOwnerTimezone();
    let happenedAt: Date | null = null;
    if (happenedAtLocal) {
      happenedAt = ownerWallClockToUtc(happenedAtLocal);
      if (!happenedAt) {
        return { ok: false as const, error: "happenedAtLocal must be YYYY-MM-DDTHH:mm owner-local time" };
      }
    }

    const { data, error } = await supabase
      .from("moments")
      .insert({
        body,
        category: category ?? null,
        ...(happenedAt ? { happened_at: happenedAt.toISOString() } : {}),
      })
      .select("id, happened_at")
      .single();
    if (error) return { ok: false as const, error: error.message };

    return {
      ok: true as const,
      id: data.id as string,
      loggedFor: formatLocal(data.happened_at as string),
    };
  },
});
