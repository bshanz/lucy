import { defineTool } from "eve/tools";
import { z } from "zod";
import { googleApiFetch } from "#lib/gmail.js";

export default defineTool({
  description:
    "Add a task to the owner's Google Tasks (default list). Optional due date (date only — " +
    "Google Tasks ignores times on due dates; for a timed nudge use create_reminder instead).",
  inputSchema: z.object({
    title: z.string().min(1),
    notes: z.string().optional(),
    dueDate: z.string().optional().describe("Due date, YYYY-MM-DD"),
  }),
  async execute({ title, notes, dueDate }) {
    const body: Record<string, string> = { title };
    if (notes) body.notes = notes;
    if (dueDate) body.due = `${dueDate}T00:00:00.000Z`;
    const created = await googleApiFetch<{ id: string }>(
      "https://tasks.googleapis.com/tasks/v1/lists/@default/tasks",
      { method: "POST", body: JSON.stringify(body) },
    );
    return { ok: true as const, id: created.id, title };
  },
});
