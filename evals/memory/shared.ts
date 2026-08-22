import { supabase } from "#lib/supabase.js";
import type { ObservedToolCall } from "../shared.js";

export { asOwnerMessage } from "../shared.js";
export type { ObservedToolCall } from "../shared.js";

/**
 * Cleanup for the memory evals, mirroring `evals/moments/shared.ts`.
 *
 * These run `remember` against the real database, because "she writes the row
 * without being told to" is the entire behaviour under test and cannot be
 * observed anywhere else. The cost is that a passing eval would otherwise leave
 * invented facts in the owner's actual long-term memory — and unlike a stray
 * diary row, a bogus memory is injected into future turns as truth about his
 * life. That makes cleanup load-bearing rather than tidy.
 *
 * Two mechanisms, same as the diary: by id from the tool's own output, and a
 * marker sweep bounded by `since` for the case where the tool wrote a row but
 * the eval died before the turn resolved.
 */

/** `remember` returns `{ ok, id }`; tolerate a JSON-encoded output too. */
function memoryIdOf(output: unknown): string | null {
  let value = output;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof value !== "object" || value === null) return null;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" ? id : null;
}

export interface EraseMemoryOptions {
  readonly calls: readonly ObservedToolCall[];
  /** ISO timestamp captured before the first send; bounds the marker sweep. */
  readonly since: string;
  /** Distinctive phrase this eval used. Omit to skip the sweep. */
  readonly marker?: string;
}

/** Delete everything this eval wrote. Never throws; loud in the artifact. */
export async function eraseEvalMemories(options: EraseMemoryOptions): Promise<string> {
  const removed = new Set<string>();
  const problems: string[] = [];

  const ids = options.calls
    .filter((call) => call.name === "remember")
    .map((call) => memoryIdOf(call.output))
    .filter((id): id is string => id !== null);

  if (ids.length > 0) {
    const { data, error } = await supabase.from("memories").delete().in("id", ids).select("id");
    if (error) problems.push(`by id: ${error.message}`);
    for (const row of data ?? []) removed.add(row.id as string);
  }

  if (options.marker) {
    const { data, error } = await supabase
      .from("memories")
      .delete()
      .gte("created_at", options.since)
      .ilike("content", `%${options.marker.replace(/[%_]/g, "")}%`)
      .select("id");
    if (error) problems.push(`by marker: ${error.message}`);
    for (const row of data ?? []) removed.add(row.id as string);
  }

  const summary = `cleanup: removed ${removed.size} memory row(s)`;
  return problems.length > 0 ? `${summary}; PROBLEMS — ${problems.join("; ")}` : summary;
}
