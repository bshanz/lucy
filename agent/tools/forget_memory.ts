import { defineTool } from "eve/tools";
import { z } from "zod";
import { deleteMemory } from "#lib/memories.js";

export default defineTool({
  description:
    "Delete one long-term memory that is wrong, outdated, or that the owner asked you to forget. " +
    "Pass the ref shown in square brackets in the recalled memory block or in recall_memories " +
    "results. Deleting is permanent; if unsure which one he means, ask first.",
  inputSchema: z.object({
    ref: z.string().min(8).describe("The 8-character ref (e.g. a1b2c3d4) or the full memory id"),
  }),
  async execute({ ref }) {
    return deleteMemory(ref);
  },
});
