import { defineTool } from "eve/tools";
import { z } from "zod";
import { googleApiFetch } from "#lib/gmail.js";

interface GTask {
  id: string;
  title?: string;
  notes?: string;
  due?: string;
  status?: string;
}

export default defineTool({
  description:
    "List the owner's Google Tasks (default task list). Shows open tasks by default; pass " +
    "includeCompleted for finished ones too.",
  inputSchema: z.object({
    includeCompleted: z.boolean().optional().describe("Default false"),
  }),
  async execute({ includeCompleted }) {
    const params = new URLSearchParams({
      maxResults: "50",
      showCompleted: includeCompleted ? "true" : "false",
      ...(includeCompleted ? { showHidden: "true" } : {}),
    });
    const data = await googleApiFetch<{ items?: GTask[] }>(
      `https://tasks.googleapis.com/tasks/v1/lists/@default/tasks?${params}`,
    );
    return {
      ok: true as const,
      tasks: (data.items ?? []).map((t) => ({
        id: t.id,
        title: t.title ?? "(untitled)",
        notes: t.notes,
        due: t.due ? t.due.slice(0, 10) : undefined,
        done: t.status === "completed",
      })),
    };
  },
});
