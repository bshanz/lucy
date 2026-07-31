import { defineTool } from "eve/tools";
import { z } from "zod";
import { supabase } from "#lib/supabase.js";

export default defineTool({
  description:
    "Search Lucy's long-term memory about the owner. Call this when context seems missing — an " +
    "unfamiliar name, 'as we discussed', a preference you should know. Empty query returns " +
    "the most recent memories.",
  inputSchema: z.object({
    query: z
      .string()
      .optional()
      .describe("Keywords to search for; omit to get the latest memories"),
    category: z.string().optional().describe("Optional category filter"),
  }),
  async execute({ query, category }) {
    let q = supabase
      .from("memories")
      .select("id, content, category, created_at")
      .order("created_at", { ascending: false })
      .limit(20);
    if (category) q = q.eq("category", category);
    if (query && query.trim()) {
      // websearch_to_tsquery-style match with ilike fallback via or()
      const pattern = `%${query.trim().replace(/[%_]/g, "")}%`;
      q = q.ilike("content", pattern);
    }
    const { data, error } = await q;
    if (error) return { ok: false as const, error: error.message };
    return {
      ok: true as const,
      memories: (data ?? []).map((m) => ({
        id: m.id as string,
        content: m.content as string,
        category: (m.category as string | null) ?? undefined,
        savedAt: (m.created_at as string).slice(0, 10),
      })),
    };
  },
});
