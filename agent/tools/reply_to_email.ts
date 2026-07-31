import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import {
  buildReplyRaw,
  getLatestInboundHeaders,
  parseAddress,
  sendReply,
} from "#lib/gmail.js";

export default defineTool({
  description:
    "Reply on an existing Gmail thread from the owner's address. REQUIRES the owner's explicit " +
    "approval — he sees the thread and reply body on an approval card first. Threading " +
    "headers (In-Reply-To/References) are fetched fresh at send time.",
  inputSchema: z.object({
    threadId: z.string().min(1).describe("Gmail thread id (from search_email/read_email)"),
    body: z
      .string()
      .min(1)
      .describe("Reply body; light markdown (bold, links, inline code) is rendered"),
  }),
  approval: always(),
  async execute({ threadId, body }) {
    const inbound = await getLatestInboundHeaders(threadId);
    if (!inbound) {
      return {
        ok: false as const,
        error: "Couldn't find an inbound message on that thread to reply to",
      };
    }
    const to = parseAddress(inbound.from);
    if (!to) return { ok: false as const, error: "Couldn't parse the recipient address" };

    const raw = buildReplyRaw({
      to,
      subject: inbound.subject,
      inReplyTo: inbound.messageId,
      references: [...inbound.references, ...(inbound.messageId ? [inbound.messageId] : [])],
      text: body,
    });
    await sendReply(threadId, raw);
    return { ok: true as const, repliedTo: to, subject: inbound.subject };
  },
});
