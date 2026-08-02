# Lucy - a personal AI assistant you text like a person

Lucy is a personal assistant that lives in **iMessage and Slack**, deployed entirely on accounts you own. She reads and triages your **Gmail**, manages your **Google Calendar and Tasks**, schedules **reminders that follow up until you actually do the thing**, keeps **long-term memory**, and quietly maintains a **diary of your life**. No third-party assistant product in the loop: your deployment, your database, your API keys, and your data live in your own Vercel, Supabase, and Google accounts. (Prefer real self-hosting? eve's build output runs on any Node host via `eve start`.)

```
you  →  iMessage: "remind me tomorrow at 9 to follow up with Alex,
                   and what's on my calendar?"

lucy →  "Got it - I'll remind you at 9am. Tomorrow you've got the
         standup at 10 and dinner at Ani Ramen at 7. Also: 2 emails
         need you - the lease renewal and an invoice from Vercel."

        (24h after an ignored reminder)
lucy →  "hey, did you ever follow up with Alex? want me to push it
         to Friday?"
```

Built on [eve](https://vercel.com/docs) (Vercel's durable-agent framework), [Sendblue](https://sendblue.com) (iMessage), [Vercel Connect](https://vercel.com) (OAuth brokering), and [Supabase](https://supabase.com) (Postgres).

## Features

- **iMessage channel** - text a number, get an assistant. Free Sendblue sandbox works (fast-polling ingress, ~10–20s replies, read receipts, typing indicators, Unicode-bold rendering since iMessage has no markdown). A dormant webhook route is included for Sendblue's paid plan (~5s replies) - flipping over is one CLI command.
- **Slack channel** - instant DMs via eve's built-in Slack channel; human-in-the-loop approvals render as real buttons.
- **Reminders with follow-through** - natural language in, DST-proof scheduling out (`daily`, `weekly`, `weekdays`, `monthly`, `every_N_days`). One-off reminders stay open until you confirm; 24h of silence earns you exactly one nudge, and "push it to Friday" reschedules conversationally.
- **Gmail** - search, read (quoted-history stripped), and send/reply. Sends are **always approval-gated**, and email content is treated as untrusted input (the persona explicitly refuses instructions embedded in emails).
- **Google Calendar + Tasks** - list/create events, manage the default task list. One OAuth grant covers all three Google services.
- **Memory + diary** - durable facts (`remember`) and timestamped moments (`log_moment`) in separate stores, both recallable conversationally ("what did I do last weekend?").
- **Flight price tracking** - price any route on demand, or watch up to 6 and get texted unprompted when a fare is genuinely notable. Google Flights (via SerpAPI) returns its own `typical_price_range` in the same call, so "is $613 good for this route?" is answerable on the *first* check with no accumulated history. Alerts are edge-triggered, not level-triggered: a fare parked below the typical range texts you once, not every day for six weeks.
- **Single-owner security model** - the only trusted iMessage sender is `OWNER_PHONE`; the only trusted Slack user is `OWNER_SLACK_USER_ID`. Everyone else is dropped in code before the model ever sees the message.

## Architecture

```
iMessage ⇄ Sendblue ←─ fast-poll cron (or webhook on paid plan)
Slack    ⇄ Vercel Connect–brokered webhooks          │
                                                     ▼
                              eve durable sessions (one per conversation)
                                        │
        ┌───────────────┬───────────────┼──────────────┬───────────────┐
        ▼               ▼               ▼              ▼               ▼
   reminders ◄─┐    memories        moments    Google APIs      flight_watches
   (Supabase)  │   (Supabase)      (Supabase)  (Gmail/Cal/       (Supabase) ◄─┐
               │                               Tasks) via                     │
   reminder-poll cron: delivers due reminders, Vercel Connect                  │
   sends 24h follow-ups, steps recurrences                                     │
                                                                               │
   flight-poll cron: hourly, acts at 9am owner-local; expires stale watches, ──┘
   claims each row before spending a metered SerpAPI search, alerts on edges
```

Design decisions worth knowing about (they're where the bugs live):

- **Claim-before-dispatch, everywhere.** Interrupted cron steps re-run in eve's durability model. Every ingress path atomically claims a message id (or flips a reminder's status) *before* dispatching to the agent, and reverts the claim on failure. A crash loses one reply at worst - it never double-texts you. This is also what lets the polling and webhook ingress run concurrently against the same inbox.
- **The model never does timezone math.** Tools accept owner-timezone wall-clock strings (`2026-08-01T17:00`); a tested converter handles UTC and DST (including the fall-back day, and recurrences that hold 5pm across clock changes). LLMs are bad at offsets exactly twice a year, which is the worst kind of bad.
- **The model doesn't know what time it is, either.** Every inbound dispatch injects the current owner-local time as session context, and time-validation errors echo the current time back so the model self-corrects in one retry ("tomorrow" from a model with no clock is a footgun).
- **Personal data lives in env, not code.** The committed persona (`agent/instructions.ts`) is fully generic; `agent/instructions/owner.ts` injects the owner's name/email/timezone at runtime from `OWNER_*` vars. (Build-time templating doesn't work here: eve evaluates instruction modules in an env-less sandbox at build.)

## Setup with an AI agent (recommended)

The fastest path: paste the prompt below into an agentic coding tool (Claude Code, Cursor, etc.) opened in an empty directory, and it will drive the setup - pausing for the handful of steps only you can do (signing into Google, sending one verification text, entering payment details if you upgrade anything).

<details>
<summary><b>📋 Copy this prompt</b></summary>

```
Set up my own instance of Lucy, the personal AI assistant from
https://github.com/bshanz/lucy - an eve (Vercel) agent reachable over iMessage
(Sendblue) and optionally Slack, with Gmail/Calendar/Tasks via Vercel Connect,
reminders, memory, and a diary, backed by Supabase.

Clone the repo first, then follow README.md's Setup section exactly. Work
through it in this order, and treat the ⚠️ traps in the README as hard
requirements - each one is a silent-failure mode someone already hit:

1. Ask me for: my name, phone (E.164), email, IANA timezone, and what I want
   the assistant called. These become the OWNER_* / AGENT_NAME env vars.
   My personal details go ONLY in .env.local and deployment env - never in
   committed files.
2. Install deps; copy .env.example to .env.local and fill in what you know.
   Generate LUCY_AGENT_SECRET with `openssl rand -hex 32`.
3. Supabase: create a project (ask me to approve any cost), apply
   supabase/migrations/0001_init.sql, collect the URL + sb_secret_ key.
4. Sendblue: `npm i -g @sendblue/cli`, then `sendblue setup --phone <my
   number> --no-wait`. Relay the verification phrase; I'll text it from my
   phone; poll `sendblue setup --check` until it lands. Then `sendblue
   show-keys` and `sendblue lines` for the env vars.
5. Vercel: `vercel link`, push every env var to production with
   `vercel env add NAME production --no-sensitive --value "..."` (the
   --no-sensitive flag matters), deploy with `vercel deploy --prod`, and
   verify /eve/v1/health. Note: 1-minute crons need Vercel Pro - check my
   plan and tell me if that's a blocker.
6. Google: walk me through the Cloud console (or drive my browser if you
   can): enable Gmail + Calendar + Tasks APIs, External consent screen
   PUBLISHED TO PRODUCTION (never leave it in Testing - refresh tokens die
   in 7 days), Web application OAuth client with redirect URI
   https://connect.vercel.com/callback in Authorized redirect URIs. Then a
   Vercel Connect OAuth connector per the README (offline+consent params on
   the auth endpoint, the three scopes, User Authorization + Refresh Tokens
   ON), UID → GMAIL_CONNECTOR_UID. Mint BOTH grants: dev via
   scripts/authorize-gmail.mjs, production via the deployed
   /eve/v1/gmail/authorize route - grants are bucketed per environment.
   I do all Google sign-ins myself.
7. Slack (ask me if I want it): follow the README's connector steps,
   including the detach/attach trigger re-point to /eve/v1/slack.
8. Verify end-to-end: npx tsc clean, `eve info` shows the channels/tools/
   schedules, then have me text the Sendblue number and confirm a reply,
   a reminder round-trip, and (if Google is connected) an inbox summary.

Never ask me to paste passwords or payment details to you; anything
requiring them, hand to me. If a step fails, check the README's ⚠️ notes
for that step before retrying differently.
```

</details>

## Setup (manual)

You'll need: Node 24+, a Vercel account (Pro, for 1-minute crons), a Supabase account, a Google account, and ~45 minutes. Every trap we know about is flagged with ⚠️.

### 1. Clone and install

```bash
git clone <this repo> && cd lucy
pnpm install   # or npm install
cp .env.example .env.local
```

### 2. Supabase

Create a project, run `supabase/migrations/0001_init.sql` in the SQL editor, and put the project URL + **secret key** (`sb_secret_...`, Project Settings → API keys) in `.env.local`.

### 3. Sendblue (iMessage)

```bash
npm install -g @sendblue/cli
sendblue setup --phone +1YOURNUMBER     # verify with one text from your iPhone
sendblue show-keys                       # → SENDBLUE_API_KEY_ID / SECRET
sendblue lines                           # → SENDBLUE_FROM_NUMBER
```

- ⚠️ The free sandbox is **inbound-first**: your phone is auto-verified by the signup text; anyone else must text your line once before it can message them. (For a single-owner assistant this is a feature.)
- ⚠️ Phone-created accounts get a synthetic `phone-...@agents.sendblue.com` email that **cannot receive dashboard sign-in links**. If you ever need the web dashboard (e.g. to upgrade plans), email support to attach a real address - don't create a second account with your email, it won't contain your line.

### 4. Vercel project

```bash
vercel link          # create/link the Vercel project
vercel env pull      # gets VERCEL_OIDC_TOKEN for local model routing
```

Add every var from `.env.local` to the Vercel project's production env (⚠️ use `vercel env add NAME production --no-sensitive --value "..."` - sensitive-flagged vars pull back as empty strings and cost you an hour).

### 5. Google (Gmail + Calendar + Tasks - one connector, one grant)

**Google Cloud console:**
1. New project → enable **Gmail API**, **Google Calendar API**, **Tasks API**.
2. OAuth consent screen: External. ⚠️ **Publish to production immediately** - in "Testing" status Google expires refresh tokens after **7 days** and your integration dies silently a week later. (Consumer accounts can't use Internal; the "unverified app" warning is a one-time click for you, the developer.)
3. Credentials → OAuth client → **Web application** → redirect URI `https://connect.vercel.com/callback`. ⚠️ In **Authorized redirect URIs**, *not* JavaScript origins (origins reject paths). Copy the client ID/secret **with the copy buttons** - hand-transcription corrupts them in ways that fail later as `401 invalid_client`.

**Vercel dashboard → Connect** → add an **OAuth** connector with your own credentials:
- Authorization endpoint: `https://accounts.google.com/o/oauth2/v2/auth?access_type=offline&prompt=consent` - ⚠️ without those two params Google never issues a refresh token and everything dies after ~1 hour.
- Token endpoint: `https://oauth2.googleapis.com/token`
- Settings → Grant Types: **User Authorization ON** with scopes `.../auth/gmail.modify`, `.../auth/calendar`, `.../auth/tasks`; **Refresh Tokens ON**.
- Link the connector to your Vercel project, copy the **UID** (⚠️ the UID, e.g. `accounts.google.com/my-connector` - not the display name) → `GMAIL_CONNECTOR_UID`.

**Create the grants** - ⚠️ Connect buckets grants **per environment**; a laptop-created grant is invisible to production, so you need one of each:

```bash
# development grant (local):
node --env-file=.env.local scripts/authorize-gmail.mjs

# production grant (after first deploy - mint the URL FROM production):
curl -H "Authorization: Bearer $LUCY_AGENT_SECRET" https://YOUR-APP.vercel.app/eve/v1/gmail/authorize
```

Open each URL, sign in as `OWNER_EMAIL`, done. The script verifies which mailbox the grant landed on.

### 6. Slack (optional)

```bash
FF_CONNECT_ENABLED=1 vercel connect create slack --name <agent-name> --triggers
# complete the browser install into your workspace, then re-point the trigger:
vercel connect detach slack/<agent-name> --yes
vercel connect attach slack/<agent-name> --triggers --trigger-path /eve/v1/slack --yes
```

⚠️ The create flow registers Connect's default trigger path, which eve doesn't serve - the detach/attach re-point is required, not optional. Set `OWNER_SLACK_USER_ID` (Slack profile → ⋮ → Copy member ID).

### 7. Deploy

```bash
npx tsc && npx eve info       # 0 errors expected; lists channels/tools/schedules
vercel deploy --prod
curl https://YOUR-APP.vercel.app/eve/v1/health
```

Text your Sendblue number. The first cron tick picks it up; typing indicator appears; reply lands. You have an assistant.

### Upgrading to instant iMessage (Sendblue paid plan)

The webhook route ships dormant. On a webhook-capable plan:

```bash
sendblue webhooks add "https://YOUR-APP.vercel.app/eve/v1/sendblue/webhook?secret=$LUCY_AGENT_SECRET" --type receive
```

The webhook and the poller share the same dedupe table, so they safely coexist - keep the poller as a fallback.

## Costs

| Item | Cost |
|---|---|
| Sendblue free sandbox | $0 (paid plan $100/mo for ~5s replies + dedicated line) |
| Supabase | free tier works; ~$10/mo on paid orgs |
| Vercel | Pro required for 1-minute crons |
| Vercel Connect | $3 per 10,000 token requests (pennies at personal scale) |
| SerpAPI (flights) | free tier = 250 searches/mo; 6 watches ≈ 186, leaving ~64 for questions. $25/mo for 1,000 |
| Model usage | via AI Gateway; a few $/mo for personal traffic |

## Security model

- Sender allowlisting happens **in code, before the model**: unknown iMessage senders and Slack users are dropped at ingress, not argued with by the prompt.
- Email content is treated as untrusted input; the persona refuses instructions embedded in mail. Outbound email is approval-gated per send.
- eve's HTTP surface fails closed in production; the webhook/authorize routes require a bearer secret (timing-safe comparison).
- Google credentials never touch app env - Vercel Connect stores and refreshes the grant server-side; the app only ever sees short-lived access tokens.
- Supabase tables have RLS enabled with no policies: service-role key only.

## Project structure

```
agent/
  agent.ts               # model selection
  instructions.ts        # persona, templated from OWNER_* env at build time
  channels/
    sendblue.ts          # iMessage: webhook route (dormant on free plan),
                         #   gmail authorize route, reply delivery, typing
    slack.ts             # Slack DMs, owner-gated
    eve.ts               # default HTTP channel (dev UI)
  schedules/
    sendblue-poll.ts     # fast-poll ingress: 5 passes × 10s per minute-cron
    reminder-poll.ts     # delivers due reminders + 24h follow-ups
    flight-poll.ts       # daily flight price checks, quota-aware, edge-triggered
  tools/                 # reminders, memory, diary, gmail, calendar, tasks, flights
  lib/                   # sendblue/gmail/serpapi clients, tz math, supabase, formatting
scripts/
  authorize-gmail.mjs    # mints the dev-environment Google grant
supabase/migrations/     # schema
```

## License

MIT
