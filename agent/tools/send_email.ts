import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { buildNewEmailRaw, sendEmail } from "#lib/gmail.js";

export default defineTool({
  description:
    "Send a NEW email from the owner's Gmail. REQUIRES the owner's " +
    "explicit approval — he sees recipient, subject, and body on an approval card first. " +
    "For replying to an existing thread use reply_to_email instead.",
  inputSchema: z.object({
    to: z.string().email().describe("Recipient address"),
    subject: z.string().min(1),
    body: z
      .string()
      .min(1)
      .describe("Email body; light markdown (bold, links, inline code) is rendered"),
  }),
  approval: always(),
  async execute({ to, subject, body }) {
    await sendEmail(buildNewEmailRaw({ to, subject, text: body }));
    return { ok: true as const, sentTo: to, subject };
  },
});
