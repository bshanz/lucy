import { defineTool } from "eve/tools";
import { z } from "zod";
import { googleApiFetch } from "#lib/gmail.js";

export default defineTool({
  description: "Mark a Google Task as completed by id (get ids from list_tasks).",
  inputSchema: z.object({
    id: z.string().min(1).describe("The task id"),
  }),
  async execute({ id }) {
    await googleApiFetch(
      `https://tasks.googleapis.com/tasks/v1/lists/@default/tasks/${encodeURIComponent(id)}`,
      { method: "PATCH", body: JSON.stringify({ status: "completed" }) },
    );
    return { ok: true as const, completed: id };
  },
});
