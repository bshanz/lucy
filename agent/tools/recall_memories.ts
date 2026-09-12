import { defineTool } from "eve/tools";
import { z } from "zod";
import { listRecent, shortId } from "#lib/memories.js";
import { supabase } from "#lib/supabase.js";

export default defineTool({
  description:
    "Search Lucy's long-term memory about the owner. The newest memories are already in your " +
    "context each turn; call this for older ones or to search by keyword — an unfamiliar name, " +
    "'as we discussed', a preference you should know. Empty query returns the most recent memories.",
  inputSchema: z.object({
    query: z
      .string()
      .optional()
      .describe("Keywords to search for; omit to get the latest memories"),
    category: z.string().optional().describe("Optional category filter"),
  }),
  async execute({ query, category }) {
    try {
      let rows;
      if (query && query.trim()) {
        let q = supabase
          .from("memories")
          .select("id, content, category, created_at")
          .order("created_at", { ascending: false })
          .limit(20)
          .ilike("content", `%${query.trim().replace(/[%_]/g, "")}%`);
        if (category) q = q.eq("category", category);
        const { data, error } = await q;
        if (error) return { ok: false as const, error: error.message };
        rows = data ?? [];
      } else {
        rows = await listRecent(20, category);
      }
      return {
        ok: true as const,
        memories: rows.map((m) => ({
          ref: shortId(m.id as string),
          content: m.content as string,
          category: (m.category as string | null) ?? undefined,
          savedAt: (m.created_at as string).slice(0, 10),
        })),
      };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  },
});
