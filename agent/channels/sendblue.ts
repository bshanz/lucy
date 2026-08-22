import { timingSafeEqual } from "node:crypto";
import { startAuthorization } from "@vercel/connect";
import { defineChannel, GET, POST } from "eve/channels";
import type { SessionAuthContext } from "eve/context";
import { isRunningStaleCode, recordPinnedDeployment } from "#lib/deployment.js";
import { gmailConnectorUid, OWNER_SUBJECT, ownerEmailAddress } from "#lib/gmail.js";
import { toImessageText } from "#lib/imessage-format.js";
import { ownerTimeContext } from "#lib/reminders.js";
import { markRead, sendMessage, sendTypingIndicator } from "#lib/sendblue.js";
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
// 30 days, not 7: the point is bounding unbounded growth, not keeping the
// transcript short. A month back is far enough that losing verbatim recall is
// theoretical, and durable facts live in Supabase (memories/moments) anyway.
const MAX_WINDOW_AGE_MS = 30 * 24 * 3600 * 1000;
const IDLE_BEFORE_ROTATE_MS = 2 * 3600 * 1000;

/**
 * A session running STALE CHANNEL CODE rotates far sooner than one merely old.
 *
 * A durable run pins to the deployment that created it, and its event handlers
 * never move — so deploying a channel fix cannot reach a session already
 * running. On 2026-08-22 that meant an `input.requested` handler shipped three
 * weeks earlier was absent from the only code that could have rendered a
 * session-limit approval, and Lucy went silent with no error anywhere.
 *
 * Rotation is the only thing that adopts new channel code, so drift becomes a
 * rotation trigger. Three days rather than thirty because the exposure is
 * asymmetric: a stale session is one unrendered event away from going quiet,
 * while losing three days of verbatim transcript costs almost nothing — durable
 * facts live in Supabase, not in the conversation.
 *
 * This is deliberately NOT an alert. Drift is permanent from the moment of any
 * deploy until the session rotates, so a warning would fire after every deploy
 * and be trained away within a week.
 */
const MAX_STALE_CODE_AGE_MS = 3 * 24 * 3600 * 1000;

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

    // Stale channel code shortens the window; everything else about rotation is
    // unchanged, including the two guards that make it safe — never mid-
    // conversation, and never while an approval is outstanding (rotating there
    // would strand a HITL request that could then never be answered).
    const stale = await isRunningStaleCode(phone);
    const maxAge = stale ? MAX_STALE_CODE_AGE_MS : MAX_WINDOW_AGE_MS;

    if (age >= maxAge && idle >= IDLE_BEFORE_ROTATE_MS && !(await hasPendingRequests(phone))) {
      const epoch = window.epoch + 1;
      await writeWindow(phone, { epoch, startedAt: nowIso, lastActivityAt: nowIso });
      console.log(
        `[sendblue] rotated conversation window → epoch ${epoch}` +
          (stale ? " (was running stale channel code)" : ""),
      );
      return tokenFor(phone, epoch);
    }

    // Old AND stale AND still can't rotate: the conversation is live, or an
    // approval is pending. Worth saying out loud — this is the exact state the
    // 2026-08-22 outage sat in, and it is the only one where a session can be
    // silently unable to render what eve asks of it.
    if (stale && age >= MAX_STALE_CODE_AGE_MS) {
      console.error(
        `[sendblue] session for ${phone} is running stale channel code and could not ` +
          "rotate (still active, or an approval is pending). It cannot adopt channel " +
          "fixes until it does.",
      );
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

/**
 * Maps the repair route's approve/deny intent onto a request's OWN option ids.
 * Confirmation kinds don't share an id vocabulary — tool approvals use
 * approve/deny, the session-limit continuation uses continue/stop — and eve
 * drops a response whose optionId isn't one of that request's options, so
 * sending the literal "approve" silently failed to resolve a limit prompt.
 */
const INTENT_SYNONYMS = {
  approve: ["approve", "continue", "allow", "yes"],
  deny: ["deny", "stop", "reject", "no"],
} as const;

function resolveIntent(intent: "approve" | "deny", options: PendingOption[]): string | undefined {
  // No options on the event (older shape) — fall back to the literal, which is
  // what tool approvals, the only kind that predates this, expect anyway.
  if (options.length === 0) return intent;
  const wanted: readonly string[] = INTENT_SYNONYMS[intent];
  return (
    options.find((o) => wanted.includes(o.id.toLowerCase()))?.id ??
    options.find((o) => wanted.includes(o.label.toLowerCase()))?.id
  );
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
      let latest: PendingRequest[] | undefined;
      for (let i = 0; i <= tail; i++) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.type === "input.requested") {
          // Carry the options through: they're what the intent resolves against.
          latest = value.data.requests.map((r) => ({
            requestId: r.requestId,
            options: (r.options ?? []).map((o) => ({ id: o.id, label: o.label })),
          }));
        }
      }
      await reader.cancel().catch(() => {});
      if (!latest || latest.length === 0) {
        return Response.json({ error: "no input.requested event in stream" }, { status: 404 });
      }

      const responses = latest.flatMap((r) => {
        const optionId = resolveIntent(option, r.options);
        return optionId === undefined ? [] : [{ requestId: r.requestId, optionId }];
      });
      if (responses.length === 0) {
        return Response.json(
          { error: `no option matches "${option}"`, requests: latest },
          { status: 409 },
        );
      }
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
        to_number?: string;
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
          // Claimed above, so the receipt is honest: Lucy has this one.
          await markRead(phone, body.to_number).catch(() => {});
          const context = ownerTimeContext();
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
    const context = ownerTimeContext();
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
      // Events fire INSIDE the durable run, so this is the one place that can
      // observe which deployment the session is actually pinned to. Called from
      // a schedule or route it would report current production and drift would
      // be permanently invisible. Best-effort: never cost a turn.
      await recordPinnedDeployment(channel.state.phone).catch(() => {});
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
        const options = request.options ?? [];
        if (request.display === "confirmation") {
          // eve writes a prompt per confirmation kind — "Approve tool call: X"
          // for tool approvals, a paragraph explaining the guardrail for the
          // session-limit continuation. Rendering toolName instead turned that
          // last one into "session_limit_continuation" plus raw numbers.
          lines.push(`⚠️ ${request.prompt || `Approval needed: ${request.action.toolName}`}`);
          // Keep the call input: "Approve tool call: Bash" is not enough to
          // approve on — the owner needs to see the command itself.
          for (const [key, value] of Object.entries(request.action.input ?? {})) {
            const text = typeof value === "string" ? value : JSON.stringify(value);
            lines.push(`${key}: ${text.length > 1200 ? `${text.slice(0, 1200)}…` : text}`);
          }
        } else {
          lines.push(request.prompt);
        }
        // Always list the request's own options rather than hardcoding
        // approve/deny: ids and labels vary by kind (approve/deny → Yes/No for
        // tools, continue/stop → Approve/Stop for the session limit), and
        // matchOption only resolves an id, a label, or a 1-based index. The old
        // hardcoded 'reply "deny"' matched nothing on a session-limit prompt.
        options.forEach((option, index) => {
          lines.push(`${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`);
        });
        if (options.length > 0) {
          lines.push(
            request.allowFreeform
              ? "Reply with a number or option name, or answer in your own words."
              : "Reply with a number or option name.",
          );
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
