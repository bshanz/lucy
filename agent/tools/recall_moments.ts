import { defineTool } from "eve/tools";
import { z } from "zod";
import { formatLocal, ownerWallClockToUtc } from "#lib/reminders.js";
import { supabase } from "#lib/supabase.js";

/**
 * Keywords match as LITERAL substrings against the moment body. That single
 * fact is why this tool takes a list, and why it has a fallback.
 *
 * The diary records what the owner SAID — "had 2 dirty martinis", "three
 * Bellinis and an espresso martini" — not the category a later question files
 * it under. So a search for "drinks" matches nothing, and reporting that as
 * "nothing logged" is a confident lie about his own life.
 *
 * That is not hypothetical. On 2026-08-22 he asked how many drinks he'd had
 * that month and was told none, with four entries and nine drinks sitting in
 * the table. The tool answered the question it was asked ("does any body
 * contain the string 'drinks'") and the answer was laundered into a claim
 * about reality. An empty keyword match is evidence about the WORDING of the
 * diary, never about whether the thing happened.
 */

/** Strip characters that would break a LIKE pattern or PostgREST's .or() grammar. */
const cleanKeyword = (k: string): string => k.replace(/[%_,()*]/g, "").trim();

export default defineTool({
  description:
    "Search the owner's diary of logged moments. Filter by keyword(s), category, and/or a NY " +
    "local-time window. Returns newest first. KEYWORDS ARE LITERAL SUBSTRINGS of his own words, " +
    "not concepts — 'drinks' does not match 'had 2 dirty martinis'. Pass `query` as a list of " +
    "alternatives, and for counting questions use a window with NO query and judge the entries " +
    "yourself. Load the `diary-recall` skill for the full procedure.",
  inputSchema: z.object({
    query: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe("Keyword or list of keywords; any one matching is a hit (literal substrings)"),
    category: z.string().optional().describe("food, activity, social, health, travel, entertainment, work"),
    fromLocal: z.string().optional().describe("Window start, NY local YYYY-MM-DDTHH:mm"),
    toLocal: z.string().optional().describe("Window end, NY local YYYY-MM-DDTHH:mm"),
    limit: z.number().int().min(1).max(100).optional().describe("Default 30"),
  }),
  async execute({ query, category, fromLocal, toLocal, limit }) {
    let from: string | undefined;
    if (fromLocal) {
      const parsed = ownerWallClockToUtc(fromLocal);
      if (!parsed) return { ok: false as const, error: "fromLocal must be YYYY-MM-DDTHH:mm" };
      from = parsed.toISOString();
    }
    let to: string | undefined;
    if (toLocal) {
      const parsed = ownerWallClockToUtc(toLocal);
      if (!parsed) return { ok: false as const, error: "toLocal must be YYYY-MM-DDTHH:mm" };
      to = parsed.toISOString();
    }

    // Built fresh each time: the fallback below re-runs it without the keywords.
    const windowQuery = () => {
      let q = supabase
        .from("moments")
        .select("id, body, category, happened_at")
        .order("happened_at", { ascending: false })
        .limit(limit ?? 30);
      if (category) q = q.eq("category", category);
      if (from) q = q.gte("happened_at", from);
      if (to) q = q.lte("happened_at", to);
      return q;
    };

    const shape = (rows: Record<string, unknown>[]) =>
      rows.map((m) => ({
        id: m.id as string,
        body: m.body as string,
        category: (m.category as string | null) ?? undefined,
        when: formatLocal(m.happened_at as string),
      }));

    const keywords = (Array.isArray(query) ? query : query ? [query] : [])
      .map(cleanKeyword)
      .filter((k) => k.length > 0);

    let q = windowQuery();
    if (keywords.length > 0) {
      // Any keyword matching is a hit — an OR, not an AND. A concept question
      // is answered by the union of the words he might have used for it.
      q = q.or(keywords.map((k) => `body.ilike.%${k}%`).join(","));
    }

    const { data, error } = await q;
    if (error) return { ok: false as const, error: error.message };
    const rows = data ?? [];

    // Nothing matched the words, but the diary is not empty for this window.
    // Hand back what IS there rather than a bare zero: the zero is a fact about
    // vocabulary, and on its own it reliably gets reported to him as a fact
    // about his life.
    if (keywords.length > 0 && rows.length === 0) {
      const { data: windowRows, error: windowError } = await windowQuery();
      if (!windowError && (windowRows ?? []).length > 0) {
        return {
          ok: true as const,
          count: (windowRows ?? []).length,
          matchedKeyword: false as const,
          note:
            `No diary entry literally contains ${keywords.map((k) => `"${k}"`).join(" or ")}. ` +
            "The diary stores his own wording, not categories, so a concept word often " +
            "appears in none of them. Below is EVERY moment in the window instead — read " +
            "them and decide yourself which ones count. Do not tell him nothing is logged " +
            "unless this list is genuinely empty.",
          moments: shape(windowRows ?? []),
        };
      }
    }

    return {
      ok: true as const,
      count: rows.length,
      ...(keywords.length > 0 ? { matchedKeyword: true as const } : {}),
      moments: shape(rows),
    };
  },
});
