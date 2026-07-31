import { timingSafeEqual } from "node:crypto";
import { startAuthorization } from "@vercel/connect";
import { defineChannel, GET, POST } from "eve/channels";
import type { SessionAuthContext } from "eve/context";
import { gmailConnectorUid, OWNER_SUBJECT, ownerEmailAddress } from "#lib/gmail.js";
import { toImessageText } from "#lib/imessage-format.js";
import { nowInOwnerTz } from "#lib/reminders.js";
import { sendMessage, sendTypingIndicator } from "#lib/sendblue.js";
import { supabase } from "#lib/supabase.js";

/**
 * iMessage channel via Sendblue.
 *
 * Ingress today is the polling schedule (agent/schedules/sendblue-poll.ts) —
 * the free sandbox has no webhooks. The webhook route below is dormant until
 * the owner upgrades to a plan with webhook support; register it then with:
 *   sendblue webhooks add https://<app>/eve/v1/sendblue/webhook?secret=<LUCY_AGENT_SECRET> --type receive
 *
 * One durable session per phone number: continuationToken = the E.164 number.
 */

type SendblueState = { phone: string };

export type SendblueReceiveTarget = { phone: string };

export function sendblueAuth(phone: string): SessionAuthContext {
  return {
    authenticator: "sendblue",
    principalType: "user",
    principalId: `sendblue:${phone}`,
    subject: "owner",
    attributes: { channel: "imessage", phone },
  };
}

function secretMatches(candidate: string | null): boolean {
  const secret = process.env.LUCY_AGENT_SECRET;
  if (!secret || !candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export default defineChannel<SendblueState, { state: SendblueState; reply: (text: string) => Promise<void> }, SendblueReceiveTarget>({
  state: { phone: "" },

  metadata: (state) => ({ channel: "sendblue", phone: state.phone }),

  context: (state) => ({
    state,
    reply: (text: string) => sendMessage(state.phone, toImessageText(text)),
  }),

  routes: [
    // Mint a Gmail consent URL FROM the deployed environment. Connect buckets
    // grants by the caller's environment, so the production grant must be
    // created by production — a laptop-created grant is invisible here.
    //   curl -H "Authorization: Bearer $LUCY_AGENT_SECRET" https://<app>/eve/v1/gmail/authorize
    GET("/eve/v1/gmail/authorize", async (req) => {
      const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
      if (!secretMatches(bearer)) return new Response("Unauthorized", { status: 401 });
      const auth = await startAuthorization(gmailConnectorUid(), {
        subject: OWNER_SUBJECT,
        scopes: ["*"],
      });
      return Response.json({
        url: auth.url,
        note: `Open this URL and sign into Google as ${ownerEmailAddress()}.`,
      });
    }),

    // Dormant until a webhook-capable Sendblue plan; the poller is ingress today.
    POST("/eve/v1/sendblue/webhook", async (req, { send, waitUntil }) => {
      const url = new URL(req.url);
      const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
      if (!secretMatches(url.searchParams.get("secret")) && !secretMatches(bearer)) {
        return new Response("Unauthorized", { status: 401 });
      }

      const body = (await req.json().catch(() => null)) as {
        from_number?: string;
        content?: string;
        is_outbound?: boolean;
        message_handle?: string;
      } | null;
      if (!body?.from_number || !body.content || body.is_outbound) {
        return new Response("ignored", { status: 200 });
      }

      const owner = process.env.OWNER_PHONE;
      if (!owner || body.from_number !== owner) {
        // Not the owner: acknowledge so Sendblue doesn't retry, but never dispatch.
        return new Response("ignored", { status: 200 });
      }

      // Claim into the shared dedupe table so the fallback poller never
      // double-processes a webhook-delivered message (and vice versa).
      if (body.message_handle) {
        const { data: claimed } = await supabase
          .from("processed_messages")
          .upsert([{ message_id: body.message_handle }], {
            onConflict: "message_id",
            ignoreDuplicates: true,
          })
          .select("message_id");
        if (!claimed || claimed.length === 0) {
          return new Response("duplicate", { status: 200 });
        }
      }

      const phone = body.from_number;
      waitUntil(
        send(
          { message: body.content, context: [`Current New York time: ${nowInOwnerTz()}.`] },
          {
            auth: sendblueAuth(phone),
            continuationToken: phone,
            state: { phone },
          },
        ),
      );
      return new Response("ok", { status: 200 });
    }),
  ],

  // Used by the sendblue-poll and reminder-poll schedules.
  async receive(input, { send }) {
    const phone = input.target.phone;
    return send(
      { message: input.message, context: [`Current New York time: ${nowInOwnerTz()}.`] },
      {
        auth: input.auth ?? sendblueAuth(phone),
        continuationToken: phone,
        state: { phone },
      },
    );
  },

  events: {
    // Show "typing…" the moment Lucy starts working on a turn, and refresh it
    // when she goes off to run tools (indicators expire after a bit; a
    // tool-heavy turn would otherwise look idle).
    async "turn.started"(_data, channel) {
      await sendTypingIndicator(channel.state.phone).catch(() => {});
    },
    async "actions.requested"(_data, channel) {
      await sendTypingIndicator(channel.state.phone).catch(() => {});
    },
    // iMessage has no buttons, so HITL prompts must go out as plain text.
    // eve resolves a reply that matches an option id, label, or 1-based index,
    // and holds unrelated messages until the request is answered — without this
    // handler the session parks silently and Lucy goes dark.
    async "input.requested"(data, channel) {
      for (const request of data.requests) {
        const lines: string[] = [];
        if (request.display === "confirmation") {
          lines.push(`⚠️ Approval needed: ${request.action.toolName}`);
          for (const [key, value] of Object.entries(request.action.input ?? {})) {
            const text = typeof value === "string" ? value : JSON.stringify(value);
            lines.push(`${key}: ${text.length > 1200 ? `${text.slice(0, 1200)}…` : text}`);
          }
          lines.push(`Reply "approve" to run it or "deny" to skip.`);
        } else {
          lines.push(request.prompt);
          const options = request.options ?? [];
          options.forEach((option, index) => {
            lines.push(`${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`);
          });
          if (options.length > 0) {
            lines.push(
              request.allowFreeform
                ? "Reply with a number, or answer in your own words."
                : "Reply with a number.",
            );
          }
        }
        await channel.reply(lines.join("\n"));
      }
    },
    async "message.completed"(data, channel) {
      // Interim narration before tool calls isn't a reply; skip it.
      if (data.finishReason === "tool-calls" || !data.message) return;
      await channel.reply(data.message);
    },
    async "turn.failed"(data, channel) {
      console.error("[sendblue] turn.failed", data);
      await channel
        .reply("Ugh, something broke on my end handling that. Mind trying again?")
        .catch((err) => console.error("[sendblue] failed to send error reply", err));
    },
    "session.failed"(data) {
      console.error("[sendblue] session.failed", data);
    },
  },
});
