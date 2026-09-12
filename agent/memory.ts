import { defineMemory, defineMemoryProvider } from "eve/memory";
import { formatForRecall, listRecent, RECALL_LIMIT } from "#lib/memories.js";

/**
 * Long-term memory as a first-class eve slot.
 *
 * Before this, memory was pull-only: the model had to notice that context was
 * missing and call `recall_memories`. It often didn't — a standing instruction
 * saved on Monday was invisible on Thursday unless something made her look.
 * Now eve asks this provider for the newest memories before EVERY owner turn
 * and puts them in context as an attributed user-role message.
 *
 * Recall-only, on purpose. Saving stays in the authored `remember` tool and
 * deletion in `forget_memory`, so the tool names the evals and the persona
 * already use don't change, and the table stays the one source of truth.
 *
 * Two decisions worth knowing about:
 *
 * - The scope is a CONSTANT, never per-principal. `byPrincipal` would key on
 *   `sendblue:<phone>` vs `slack:<team>:<user>` and quietly split memory by
 *   channel, which the README promises not to do. Both channels stamp
 *   `subject: "owner"` from verified auth; that is the shared key. Anything
 *   else (the app principal on schedule-driven turns, anonymous) returns null,
 *   which disables the slot for that turn — the model can still call
 *   `recall_memories` there.
 * - Recall never throws. A throwing `turn.started` recall fails the whole turn
 *   before the model runs, so a Supabase blip would turn "she doesn't remember
 *   your dentist" into "she doesn't answer". Same rule as the session window:
 *   degraded is survivable, dropped is not.
 */

const OWNER_SCOPE = "owner";

async function recall(): Promise<{ messages: { id: string; content: string }[] } | null> {
  try {
    const rows = await listRecent(RECALL_LIMIT);
    const content = formatForRecall(rows);
    if (!content) return null;
    // One keyed message: each turn's copy supersedes the last instead of
    // piling up in session history.
    return { messages: [{ id: "recent-memories", content }] };
  } catch (err) {
    console.warn("[memory] recall failed; continuing without long-term memory this turn", err);
    return null;
  }
}

export default defineMemory({
  description: "Durable facts and preferences about the owner's life.",

  // Explicit so `eve dev`, evals and production read the same rows. The
  // default namespace differs per environment, which is right for a
  // per-tenant store and wrong for a single owner's one table.
  namespace: "lucy",

  scope(ctx) {
    const caller = ctx.session.auth.current;
    if (!caller) return null;
    if (caller.principalType === "local-dev") return OWNER_SCOPE; // eve dev / eve eval
    return caller.subject === "owner" ? OWNER_SCOPE : null;
  },

  provider: defineMemoryProvider({
    recall: {
      "turn.started": recall,
      // Re-inject after compaction so the block survives the checkpoint.
      "compaction.completed": recall,
    },
  }),

  visibility: "scope",
});
