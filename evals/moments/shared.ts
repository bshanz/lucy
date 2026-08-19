import { supabase } from "#lib/supabase.js";
import type { ObservedToolCall } from "../shared.js";

/**
 * `asOwnerMessage` and `ObservedToolCall` moved to `evals/shared.ts` when the
 * flights evals needed them too. Re-exported so these files keep importing
 * everything from one place.
 */
export { asOwnerMessage } from "../shared.js";
export type { ObservedToolCall } from "../shared.js";

/**
 * Cleanup for the diary evals.
 *
 * These evals exercise `log_moment` against the real database, because that is
 * the only place the behaviour under test actually lives — the whole feature is
 * "she writes a row without being asked". The cost is that a passing eval would
 * otherwise leave fake entries in the owner's actual diary, and the diary is
 * read back by `recall_moments` as a count ("how many times this month?"). A
 * stray "pistachio at Morgenstern's" is not clutter, it's a wrong answer to a
 * question he asks later.
 *
 * So every eval that can cause a write erases its own rows in a `finally`.
 * Two mechanisms, deliberately:
 *
 *  1. By id, read out of the tool's own output. Exact, and the normal path.
 *  2. A marker sweep — rows created since the eval started whose body carries a
 *     phrase only this eval says. This catches the case the first mechanism
 *     can't see: the tool ran and wrote a row, but the eval crashed before the
 *     turn resolved, or the output shape changed under us.
 *
 * The sweep is bounded by `since` as well as the marker so it can never reach a
 * row that predates the run.
 */

/** `log_moment` returns `{ ok, id, loggedFor }`; tolerate a JSON-encoded output too. */
function momentIdOf(output: unknown): string | null {
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

/** Ids of every moment written by the observed calls. */
export function loggedMomentIds(calls: readonly ObservedToolCall[]): string[] {
  return calls
    .filter((call) => call.name === "log_moment")
    .map((call) => momentIdOf(call.output))
    .filter((id): id is string => id !== null);
}

export interface EraseOptions {
  /** Tool calls observed on the turn, e.g. `turn.toolCalls`. */
  readonly calls: readonly ObservedToolCall[];
  /** ISO timestamp captured before the first send; bounds the marker sweep. */
  readonly since: string;
  /** Distinctive phrase this eval used, e.g. "Morgenstern". Omit to skip the sweep. */
  readonly marker?: string;
}

/**
 * Delete everything this eval wrote. Returns the row count for `t.log`.
 * Never throws — cleanup failing must not turn a green eval red, but it must be
 * loud in the artifact, because the failure mode is silent diary pollution.
 */
export async function eraseEvalMoments(options: EraseOptions): Promise<string> {
  const removed = new Set<string>();
  const problems: string[] = [];

  const ids = loggedMomentIds(options.calls);
  if (ids.length > 0) {
    const { data, error } = await supabase.from("moments").delete().in("id", ids).select("id");
    if (error) problems.push(`by id: ${error.message}`);
    for (const row of data ?? []) removed.add(row.id as string);
  }

  if (options.marker) {
    const { data, error } = await supabase
      .from("moments")
      .delete()
      .gte("created_at", options.since)
      .ilike("body", `%${options.marker.replace(/[%_]/g, "")}%`)
      .select("id");
    if (error) problems.push(`by marker: ${error.message}`);
    for (const row of data ?? []) removed.add(row.id as string);
  }

  const summary = `cleanup: removed ${removed.size} moment row(s)`;
  return problems.length > 0 ? `${summary}; PROBLEMS — ${problems.join("; ")}` : summary;
}
