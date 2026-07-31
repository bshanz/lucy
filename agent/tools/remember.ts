import { defineTool } from "eve/tools";
import { z } from "zod";
import { supabase } from "#lib/supabase.js";

export default defineTool({
  description:
    "Save a durable fact about the owner's life to long-term memory (shared across iMessage and " +
    "Slack). Use for people, preferences, routines, projects, decisions, important dates. " +
    "One self-contained fact per call.",
  inputSchema: z.object({
    content: z.string().min(1).describe("The fact, phrased so it makes sense on its own later"),
    category: z
      .string()
      .optional()
      .describe("Optional grouping, e.g. people, preferences, work, health, dates"),
  }),
  async execute({ content, category }) {
    const { data, error } = await supabase
      .from("memories")
      .insert({ content, category: category ?? null })
      .select("id")
      .single();
    if (error) return { ok: false as const, error: error.message };
    return { ok: true as const, id: data.id as string };
  },
});
