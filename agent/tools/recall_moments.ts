import { defineTool } from "eve/tools";
import { z } from "zod";
import { formatLocal, ownerWallClockToUtc } from "#lib/reminders.js";
import { supabase } from "#lib/supabase.js";

export default defineTool({
  description:
    "Search the owner's diary of logged moments. Filter by keyword, category, and/or a NY " +
    "local-time window ('what did I do last weekend?' → fromLocal/toLocal for those days; " +
    "'how many times did I get ice cream this month?' → query + window, then count). " +
    "Returns newest first.",
  inputSchema: z.object({
    query: z.string().optional().describe("Keyword to match in the moment text"),
    category: z.string().optional().describe("food, activity, social, health, travel, entertainment, work"),
    fromLocal: z.string().optional().describe("Window start, NY local YYYY-MM-DDTHH:mm"),
    toLocal: z.string().optional().describe("Window end, NY local YYYY-MM-DDTHH:mm"),
    limit: z.number().int().min(1).max(100).optional().describe("Default 30"),
  }),
  async execute({ query, category, fromLocal, toLocal, limit }) {
    let q = supabase
      .from("moments")
      .select("id, body, category, happened_at")
      .order("happened_at", { ascending: false })
      .limit(limit ?? 30);

    if (category) q = q.eq("category", category);
    if (query && query.trim()) {
      q = q.ilike("body", `%${query.trim().replace(/[%_]/g, "")}%`);
    }
    if (fromLocal) {
      const from = ownerWallClockToUtc(fromLocal);
      if (!from) return { ok: false as const, error: "fromLocal must be YYYY-MM-DDTHH:mm" };
      q = q.gte("happened_at", from.toISOString());
    }
    if (toLocal) {
      const to = ownerWallClockToUtc(toLocal);
      if (!to) return { ok: false as const, error: "toLocal must be YYYY-MM-DDTHH:mm" };
      q = q.lte("happened_at", to.toISOString());
    }

    const { data, error } = await q;
    if (error) return { ok: false as const, error: error.message };

    return {
      ok: true as const,
      count: (data ?? []).length,
      moments: (data ?? []).map((m) => ({
        id: m.id as string,
        body: m.body as string,
        category: (m.category as string | null) ?? undefined,
        when: formatLocal(m.happened_at as string),
      })),
    };
  },
});
