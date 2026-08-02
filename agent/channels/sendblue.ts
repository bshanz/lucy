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
 * Sessions are windowed per phone number (see sessionToken): a single forever
 * session would re-send an ever-growing compacted context on every text, and
 * eventually trip eve's 40M-input-token session budget with a bare
 * Approve/Stop prompt the owner never asked for.
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

/**
 * Pending HITL requests, persisted in channel_state so ingress can translate
 * an "approve"-style text into a structured inputResponse. eve's own text
 * matcher compares the WHOLE coalesced message against the options, so once
 * any unrelated text is queued behind a pending approval, no plain-text reply
 * can ever match again — structured responses bypass the text matcher and
 * resolve even with held text queued.
 */
type PendingOption = { id: string; label: string };
type PendingRequest = { requestId: string; options: PendingOption[] };

const pendingInputKey = (phone: string) => `sendblue:pending_input:${phone}`;

async function storePendingRequests(phone: string, requests: PendingRequest[]): Promise<void> {
  await supabase.from("channel_state").upsert(
    [{ key: pendingInputKey(phone), value: { requests }, updated_at: new Date().toISOString() }],
    { onConflict: "key" },
  );
}

async function clearPendingRequests(phone: string): Promise<void> {
  await supabase.from("channel_state").delete().eq("key", pendingInputKey(phone));
}

/**
 * Conversation windows.
 *
 * eve compacts a long session automatically, so context overflow is handled —
 * but the transcript still grows, every turn re-sends the whole compacted
 * context as input, and root sessions carry a default 40M input-token budget.
 * Cross it and eve pauses and emits an Approve/Stop continuation prompt, which
 * over iMessage reads like Lucy malfunctioning. Windowing keeps each session
 * days old instead of years, so the budget is never approached and the cap goes
 * back to being what it's good for: a runaway-loop backstop.
 *
 * Rotation is IDLE-BASED, never wall-clock. A window turns over only once it is
 * old AND the conversation has gone quiet, so a reply is never answered by a
 * session with no memory of the question. It is also suppressed while an
 * approval is pending — rotating there would strand a HITL request that can
 * then never be answered.
 *
 * Epoch 0 maps to the bare phone number, so the session already running when
 * this shipped is adopted rather than abandoned.
 */
const MAX_WINDOW_AGE_MS = 7 * 24 * 3600 * 1000;
const IDLE_BEFORE_ROTATE_MS = 2 * 3600 * 1000;

type SessionWindow = { epoch: number; startedAt: string; lastActivityAt: string };

const sessionKey = (phone: string) => `sendblue:session:${phone}`;

function tokenFor(phone: string, epoch: number): string {
  return epoch === 0 ? phone : `${phone}#${epoch}`;
}

async function writeWindow(phone: string, window: SessionWindow): Promise<void> {
  await supabase.from("channel_state").upsert(
    [{ key: sessionKey(phone), value: window, updated_at: new Date().toISOString() }],
    { onConflict: "key" },
  );
}

async function hasPendingRequests(phone: string): Promise<boolean> {
  const { data } = await supabase
    .from("channel_state")
    .select("value")
    .eq("key", pendingInputKey(phone))
    .maybeSingle();
  const requests = (data?.value as { requests?: PendingRequest[] } | null)?.requests;
  return Array.isArray(requests) && requests.length > 0;
}

/**
 * The continuation token for this phone's current conversation window, marking
 * activity as a side effect. Pass `{ rotate: false }` for read-only lookups
 * (the resolve-input repair path) so inspecting a session can never move it.
 *
 * Never throws: if the state store is unreachable we fall back to the bare
 * phone number. A degraded window is survivable; a dropped text is not.
 */
export async function sessionToken(phone: string, opts?: { rotate?: boolean }): Promise<string> {
  const rotate = opts?.rotate !== false;
  try {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const { data } = await supabase
      .from("channel_state")
      .select("value")
      .eq("key", sessionKey(phone))
      .maybeSingle();
    const window = (data?.value as SessionWindow | null) ?? null;

    if (!window) {
      if (rotate) await writeWindow(phone, { epoch: 0, startedAt: nowIso, lastActivityAt: nowIso });
      return phone;
    }
    if (!rotate) return tokenFor(phone, window.epoch);

    const age = now - Date.parse(window.startedAt);
    const idle = now - Date.parse(window.lastActivityAt);
    if (age >= MAX_WINDOW_AGE_MS && idle >= IDLE_BEFORE_ROTATE_MS && !(await hasPendingRequests(phone))) {
      const epoch = window.epoch + 1;
      await writeWindow(phone, { epoch, startedAt: nowIso, lastActivityAt: nowIso });
      console.log(`[sendblue] rotated conversation window → epoch ${epoch}`);
      return tokenFor(phone, epoch);
    }

    await writeWindow(phone, { ...window, lastActivityAt: nowIso });
    return tokenFor(phone, window.epoch);
  } catch (err) {
    console.warn("[sendblue] session window lookup failed; using bare phone token", err);
    return phone;
  }
}

// Mirrors eve's follow-up matcher (option id, label, or 1-based index,
// case-insensitive) so a matching text resolves identically to a button press.
function matchOption(text: string, options: PendingOption[]): string | undefined {
  const normalized = text.trim().toLowerCase();
  const match =
    options.find((o) => o.id.toLowerCase() === normalized) ??
    options.find((o) => o.label.toLowerCase() === normalized);
  if (match) return match.id;
  const index = Number(normalized);
  if (Number.isInteger(index) && index >= 1 && index <= options.length) {
    return options[index - 1].id;
  }
  return undefined;
}

async function matchPendingResponses(
  phone: string,
  text: string,
): Promise<{ requestId: string; optionId: string }[]> {
  const { data } = await supabase
    .from("channel_state")
    .select("value")
    .eq("key", pendingInputKey(phone))
    .maybeSingle();
  const requests = (data?.value as { requests?: PendingRequest[] } | null)?.requests;
  if (!Array.isArray(requests)) return [];
  const responses: { requestId: string; optionId: string }[] = [];
  for (const request of requests) {
    const optionId = matchOption(text, request.options ?? []);
    if (optionId) responses.push({ requestId: request.requestId, optionId });
  }
  return responses;
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

    // Escape hatch: answer the owner session's most recent pending HITL
    // requests with one option, reading requestIds off the durable event
    // stream. Needed when an approval predates the pending-input store (or the
    // store row is lost) and held text has made text replies unmatchable.
    //   curl -X POST -H "Authorization: Bearer $LUCY_AGENT_SECRET" \
    //     "https://<app>/eve/v1/sendblue/resolve-input?option=approve"
    POST("/eve/v1/sendblue/resolve-input", async (req, { send, resolveActiveSession, getSession }) => {
      const url = new URL(req.url);
      const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
      if (!secretMatches(bearer)) return new Response("Unauthorized", { status: 401 });
      const option = url.searchParams.get("option");
      if (option !== "approve" && option !== "deny") {
        return Response.json({ error: 'pass ?option=approve or ?option=deny' }, { status: 400 });
      }
      const phone = process.env.OWNER_PHONE;
      if (!phone) return Response.json({ error: "OWNER_PHONE not set" }, { status: 500 });

      // rotate:false — this is the repair path; inspecting must not move the window.
      const repairToken = await sessionToken(phone, { rotate: false });
      const active = await resolveActiveSession({ continuationToken: repairToken });
      if (!active) return Response.json({ error: "no active session" }, { status: 404 });
      const session = getSession(active.sessionId);

      const tail = await session.getStreamTailIndex();
      if (tail < 0) return Response.json({ error: "empty event stream" }, { status: 404 });
      const stream = await session.getEventStream({ startIndex: 0 });
      const reader = stream.getReader();
      let latest: { requestId: string }[] | undefined;
      for (let i = 0; i <= tail; i++) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.type === "input.requested") {
          latest = value.data.requests.map((r) => ({ requestId: r.requestId }));
        }
      }
      await reader.cancel().catch(() => {});
      if (!latest || latest.length === 0) {
        return Response.json({ error: "no input.requested event in stream" }, { status: 404 });
      }

      const responses = latest.map((r) => ({ requestId: r.requestId, optionId: option }));
      await send(
        { inputResponses: responses },
        { auth: sendblueAuth(phone), continuationToken: repairToken, state: { phone } },
      );
      await clearPendingRequests(phone).catch(() => {});
      return Response.json({ resolved: responses });
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
      const content = body.content;
      waitUntil(
        (async () => {
          const context = [`Current New York time: ${nowInOwnerTz()}.`];
          const options = {
            auth: sendblueAuth(phone),
            continuationToken: await sessionToken(phone),
            state: { phone },
          };
          const responses = await matchPendingResponses(phone, content).catch(() => []);
          if (responses.length > 0) {
            await send({ inputResponses: responses, context }, options);
            await clearPendingRequests(phone).catch(() => {});
          } else {
            await send({ message: content, context }, options);
          }
        })(),
      );
      return new Response("ok", { status: 200 });
    }),
  ],

  // Used by the sendblue-poll and reminder-poll schedules.
  async receive(input, { send }) {
    const phone = input.target.phone;
    const context = [`Current New York time: ${nowInOwnerTz()}.`];
    const options = {
      auth: input.auth ?? sendblueAuth(phone),
      // Schedule-initiated messages (reminders, flight alerts) land in the same
      // window as the owner's texts, and count as activity like any other turn.
      continuationToken: await sessionToken(phone),
      state: { phone },
    };
    if (typeof input.message === "string") {
      const responses = await matchPendingResponses(phone, input.message).catch(() => []);
      if (responses.length > 0) {
        const session = await send({ inputResponses: responses, context }, options);
        await clearPendingRequests(phone).catch(() => {});
        return session;
      }
    }
    return send({ message: input.message, context }, options);
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
      // Persist before texting so a fast reply can't race the store.
      const optionRequests = data.requests
        .filter((request) => (request.options?.length ?? 0) > 0)
        .map((request) => ({
          requestId: request.requestId,
          options: (request.options ?? []).map((option) => ({ id: option.id, label: option.label })),
        }));
      if (optionRequests.length > 0) {
        await storePendingRequests(channel.state.phone, optionRequests).catch((err) =>
          console.error("[sendblue] failed to persist pending input", err),
        );
      }
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
