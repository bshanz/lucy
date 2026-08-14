# Lucy - a personal AI assistant you text like a person

Lucy is a personal assistant that lives in **iMessage and Slack**, deployed entirely on accounts you own. She reads and triages your **Gmail**, manages your **Google Calendar and Tasks**, schedules **reminders that follow up until you actually do the thing**, books **restaurant reservations** (including sniping tables the second they drop), keeps **long-term memory**, and quietly maintains a **diary of your life**. No third-party assistant product in the loop: your deployment, your database, your API keys, and your data live in your own Vercel, Supabase, and Google accounts. (Prefer real self-hosting? eve's build output runs on any Node host via `eve start`.)

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
- **Reminders with follow-through** - natural language in, DST-proof scheduling out (`daily`, `weekly`, `weekdays`, `monthly`, `every_N_days`). One-off reminders stay open until you confirm; silence earns up to three nudges on a widening curve (a day, then three days, then a week, the last one announced as the last, all clamped to waking hours), after which the reminder stops chasing you but stays on your list. "Push it to Friday" reschedules conversationally and restarts the cycle.
- **Gmail** - search, read (quoted-history stripped), and send/reply. Sends are **always approval-gated**, and email content is treated as untrusted input (the persona explicitly refuses instructions embedded in emails). Email can also be **scheduled** - "email Bob at 9 tomorrow" - and that moves the approval card *earlier* rather than deferring it: you approve the finished draft now, and at 9am it sends unattended with no second prompt. Same trust model as sniping (you approve the watch, not the booking), and it holds for the same reason - the sender can only replay. There is no model in the loop at send time, so the bytes on the card are the bytes that arrive.
- **Google Calendar + Tasks** - list, create, and update events, manage the default task list. One OAuth grant covers all three Google services. Events can carry **guests**: pass attendees and Google sends the real invitations, and adding, removing, or rescheduling anyone lands behind an approval card first, since every one of those actions mails a person who isn't you. Solo events stay unprompted. Lucy will not invent an address to invite - she resolves it from memory or your Gmail, or asks.
- **Texting other people** - "text Alex I'm running 15 late" sends now; "text Alex at 8 tomorrow" queues and fires unattended, same approve-the-draft-not-the-send trade as scheduled email. The first message to a number carries **the assistant's own contact card** as a vCard, so one tap turns every later text from an unknown number into a name. The card is the assistant's, not the owner's: his name goes in the `ORG` line, the phone number on it is the Sendblue line, and his personal mobile and address are on it nowhere - which is checked, not merely intended, because Sendblue hosts the card at a public unauthenticated URL. An optional avatar is embedded base64 (`scripts/set-contact-photo.ts`), stored in Supabase rather than committed or stuffed into env. The card is built from the tool's input, so the check that the message is well-formed runs in the *approval policy*, before any card is drawn - which is what lets the guarantee be the strong one: **the characters on the card are the characters that arrive**, with nothing added afterwards. These leave from Lucy's Sendblue line rather than your phone, so the first message to any number is required to open with a fixed sentence introducing you, and the tool refuses until it does. A ten-digit number with no country code is accepted only if *your* number is North American; everywhere else it's refused rather than guessed, because guessing a country code means sending your words to whoever holds that number there.
- **Memory + diary** - durable facts (`remember`) and timestamped moments (`log_moment`) in separate stores, both recallable conversationally ("what did I do last weekend?").
- **Flight price tracking** - price any route on demand, or watch up to 6 and get texted unprompted when a fare is genuinely notable. Google Flights (via SerpAPI) returns its own `typical_price_range` in the same call, so "is $613 good for this route?" is answerable on the *first* check with no accumulated history. Alerts are edge-triggered, not level-triggered: a fare parked below the typical range texts you once, not every day for six weeks.
- **Restaurant reservations (Resy)** - search, check availability, book, and cancel on your own Resy account. The real feature is **sniping**: hard tables drop at an exact second weeks in advance and are gone in under ten, which is far less time than an approval round-trip over iMessage. So you approve the *watch*, not the booking - venue, date, party size, time window, deposit cap - and at the drop moment Lucy books unattended inside those bounds and texts you the result, win or lose. The time window is a hard bound, not a preference: a table outside it is one you never authorised. Venue constraints are checked at arm time rather than discovered at T-0, because some venues gate booking behind a reCAPTCHA (this varies *between locations of the same restaurant* - Carbone NYC can be sniped, Carbone Miami can't) and arming a snipe that was never going to work is worse than refusing it. You link the account **by conversation, not by config**: Resy signs in with a texted code, so you say "connect resy", she has Resy text your phone, and you text the six digits back. That session lasts ~45 days and, on a code-linked account, genuinely cannot renew itself - Resy issues no refresh token - so Lucy watches the clock and nudges you at 7, 3 and 1 days out rather than letting a snipe discover it at 9am on drop day.
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
   sends escalating follow-ups, steps recurrences                              │
                                                                               │
   flight-poll cron: hourly, acts at 9am owner-local; expires stale watches, ──┘
   claims each row before spending a metered SerpAPI search, alerts on edges

   resy-snipe cron: every minute; claims snipes dropping in the next ~90s,
   pre-warms key+token off the clock, then holds the invocation and sleeps to
   the exact millisecond before racing /4/find → /3/details → /3/book
   resy-auth cron: hourly, acts at 4am owner-local; probes the session and
   warns at 7/3/1 days - a code-linked session has no refresh token to roll

   text-send cron: every minute; replays pre-approved texts to other people
   verbatim, no model in the loop; an interrupted send is resolved by asking
   Sendblue what it actually sent, never by retrying
   text-replies cron: every minute; sends each new correspondent ONE fixed
   line, then relays what they said to the owner as untrusted third-party text
```

Design decisions worth knowing about (they're where the bugs live):

- **Claim-before-dispatch, everywhere.** Interrupted cron steps re-run in eve's durability model. Every ingress path atomically claims a message id (or flips a reminder's status) *before* dispatching to the agent, and reverts the claim on failure. A crash loses one reply at worst - it never double-texts you. This is also what lets the polling and webhook ingress run concurrently against the same inbox.
- **The model never does timezone math.** Tools accept owner-timezone wall-clock strings (`2026-08-01T17:00`); a tested converter handles UTC and DST (including the fall-back day, and recurrences that hold 5pm across clock changes). LLMs are bad at offsets exactly twice a year, which is the worst kind of bad.
- **The model doesn't know what time it is, either.** Every inbound dispatch injects the current owner-local time as session context, and time-validation errors echo the current time back so the model self-corrects in one retry ("tomorrow" from a model with no clock is a footgun).
- **No browser in the Resy path, on purpose.** The obvious way to automate a reservation site is a persistent headless browser. It's the wrong tool here: plain `fetch` gets clean 200s on search, auth, availability and booking alike, and a bad key comes back as a tidy JSON `419` rather than an HTML challenge. A browser would buy nothing and cost the one thing that matters - it cannot hit a millisecond deadline. (The Akamai/Cloudflare war stories in the community tooling are about OpenTable and Tock, not Resy.) `@agent-browser/eve` stays mounted as the escape hatch if that changes. Worth being precise about *why* rather than repeating the folklore: api.resy.com **is** behind Imperva (`x-cdn: Imperva`), which an earlier version of this note missed by grepping only for Akamai and Cloudflare headers. It has never challenged us, but it is a WAF - hence the boring request shape and the bounded retry cap in the drop race.

- **Resy's OTP login is three steps, and two of them are counter-intuitive.** Verified against the live API, not inferred: `4/auth/mobile` sends the code; the code is verified by POSTing it **back to that same endpoint** (sending `code` is what distinguishes verify from request); Resy then answers with a *challenge* - "Hey Brian, is that you?" - demanding a second factor, the account **email**, which `4/auth/challenge` exchanges for the token. Posting the code to `4/auth/challenge` instead returns `{"challenge_id": "An invalid challenge_id was provided"}`, which reads like a bad code and is really a bad endpoint - a two-step implementation gets a 200 with no token and looks identical to a rejected code. Note also that OTP login returns **no refresh token**; the 45-day/90-day pair the community Go clients document belongs to the password flow, which an OTP-only account (`has_set_password: 0`) can't use. **Phone and email both come from `OWNER_PHONE`/`OWNER_EMAIL`, never from a tool argument** - together they are the entire credential, so nothing that talks its way into a prompt can redirect a login code to a phone someone else holds.

- **The Resy API key is scraped at runtime, never pinned.** Every Resy bot on GitHub hardcodes `VbWk7s3L4KiK5fzlO7JD3Q5EYolJI4G1`. That key is dead; the live one ends `…lJI7n5` and will rotate again. `agent/lib/resy.ts` pulls it out of resy.com's JS bundle and caches it for six hours, which is the difference between an integration that rots and one that doesn't.

- **The pre-warm is what wins the table, not the polling loop.** Scraping the key is two round trips and refreshing the token is a third; paying for those at T-0 loses the race. `resy-snipe` claims the row ~90s early, warms everything ~10s early, then holds the invocation and sleeps to the exact millisecond before it starts asking. Vercel cron only fires once a minute - the in-invocation hold is what turns that into second-level precision, the same trick `sendblue-poll` uses for latency.

- **The spending cap is enforced on a field that actually exists, in units that were checked.** Two bugs here were live at once and neither raised an error. The card was attached only when a deposit looked due - but plenty of venues want a card *on file* to hold a **free** table and charge only for a no-show, and Resy answers a missing one with a bare `402` that is indistinguishable from a real deposit demand, so booking failed *and* the error text confidently told the owner he had no card while two sat on his account. Meanwhile the charge was read from `config.deposit_fee`, a field on no Resy response, so every venue priced as $0 and the cap was never enforced at all: a **$400** prix fixe would have walked straight through a $50 limit. The real amount is `payment.amounts.total`, in **dollars** while everything here counts integer cents - one conversion boundary, now its own function with tests against verbatim live payloads. The general lesson, and the reason this bullet exists: a plausible-looking field name that doesn't exist fails *silently and permissively*, and money code is where that is least survivable.

- **The approval card is built from the tool's input, which decides where validation goes.** On iMessage there are no buttons, so `input.requested` renders the call by iterating `request.action.input` and printing each key. That is a nicer property than it looks: whatever the model passed is exactly what you read. But it means a tool that tidies its own input inside `execute` — prepending a line, stripping markdown — is showing you one message and sending another, and for a text to another person that is the whole ballgame. So `send_text`/`schedule_text` don't compose, they *verify*: the model must pass the finished message, and the check runs in the `approval` policy (which can return `{ type: "denied", reason }`) so a malformed one is bounced back to the model **before** a card exists. You never see a card that isn't byte-identical to what sends. The cost is one extra round trip the first time you text someone; the alternative was a footnote explaining why the message you approved isn't the message that arrived.

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
3. Supabase: create a project (ask me to approve any cost), apply every file in
   supabase/migrations/ in filename order, collect the URL + sb_secret_ key.
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
8. Resy (ask me if I want it): nothing to configure - after deploying, tell
   me to text "connect resy" and relay the six-digit code back to the
   assistant. Do NOT ask me for a Resy password; most accounts don't have
   one. Run scripts/check-resy-live.ts to confirm; it stops before booking.
9. Verify end-to-end: npx tsc clean, `eve info` shows the channels/tools/
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

Create a project, run every file in `supabase/migrations/` in filename order in the SQL editor, and put the project URL + **secret key** (`sb_secret_...`, Project Settings → API keys) in `.env.local`. `0001_init.sql` alone isn't enough — the later migrations add flight tracking and the reminder follow-up columns, and the crons will fail at runtime without them.

### 3. Sendblue (iMessage)

```bash
npm install -g @sendblue/cli
sendblue setup --phone +1YOURNUMBER     # verify with one text from your iPhone
sendblue show-keys                       # → SENDBLUE_API_KEY_ID / SECRET
sendblue lines                           # → SENDBLUE_FROM_NUMBER
```

- ⚠️ The free sandbox is **inbound-first**: your phone is auto-verified by the signup text; anyone else must text your line once before it can message them. For a single-owner assistant that's a feature - but it's also the one prerequisite for `send_text`, so a friend you want Lucy to text has to send one message to your line first. Their message is dropped before the model sees it, exactly as any non-owner message is; Sendblue still records the contact, and it holds from then on.

  **There is no way around this on the free plan, and the near-misses are worth writing down** because all three look like they should work. Verified against the live API, not inferred:

  | Attempt | Result |
  | --- | --- |
  | `POST /api/send-message` to a non-contact | `400` — `"This contact must be verified before sending messages to it."` |
  | `POST /api/v2/contacts` (i.e. `sendblue add-contact`) | `200 OK`, contact created… and the send is **still** refused with the same error |
  | `POST /api/v2/contacts/verify` | `"No contact found for this number"` — even for a contact that was just created and reads back fine from `GET /api/v2/contacts/{number}` |

  So adding a contact registers a name, not a permission, and the endpoint that sounds like the bootstrap path isn't one. The only thing that verifies a contact is an inbound text from them. Lifting it means a dedicated line ($100/mo), which raises the ceiling to 50 new contacts/day; the other way out is a different carrier entirely, which for US SMS means A2P 10DLC registration and green bubbles.

  Lucy handles this in two places rather than one: `contactBlock()` refuses a send to a number Sendblue has never heard of **before the approval card is drawn** (a definite no - `GET /api/v2/contacts/{number}` 404s cleanly - and never a green light, since the table above shows a known contact can still be unsendable), and `explainSendFailure()` catches the rest against the verbatim error string above, which `check-text-claim.ts` pins so a reword gets noticed.
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
- Settings → Grant Types: **User Authorization ON** with scopes `.../auth/gmail.modify`, `.../auth/calendar`, `.../auth/tasks`; **Refresh Tokens ON**. (`.../auth/calendar` is full read/write and already covers sending invites - guests need no extra scope and no re-consent.)
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

### 7. Resy (optional)

Nothing to configure. Resy signs in with a texted code, so you link it by talking to Lucy after deploying: say **"connect resy"**, she asks Resy to text `OWNER_PHONE`, you send her the six digits, done. `scripts/connect-resy.ts` does the same from a terminal if you'd rather (`--send` is an explicit flag, because it makes a real phone buzz).

⚠️ The session lasts ~45 days and **cannot renew itself** if your account has no password (`has_set_password: 0`, which is most accounts) - Resy returns no refresh token for a code login. Lucy warns at 7/3/1 days; re-linking is one more code. If you *do* have a password, setting `RESY_EMAIL`/`RESY_PASSWORD` gives her a self-healing fallback.

⚠️ Some venues can't be auto-booked at all, and it varies **between locations of the same restaurant** - Carbone NYC can be sniped, Carbone Miami can't (`feature_recaptcha`). `search_resy` reports it and `snipe_resy` refuses to arm one, deliberately: an armed snipe that was never going to win is worse than a refusal, because you stop looking for a table.

Verify without booking anything:

```bash
npx tsx scripts/check-calendar-logic.ts                      # guest-list logic, no network
npx tsx scripts/check-resy-logic.ts                          # pure logic, no network
npx tsx --env-file=.env.local scripts/check-resy-claim.ts    # no double-booking
npx tsx --env-file=.env.local scripts/check-email-claim.ts   # no double-sent email
npx tsx --env-file=.env.local scripts/check-text-claim.ts    # no double-sent text
npx tsx --env-file=.env.local scripts/check-contact-card.ts  # vCard shape + folding
npx tsx --env-file=.env.local scripts/check-resy-live.ts     # live, stops before /3/book
```

### 8. Deploy

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
| Resy | $0 - your own account, no API fees. Deposits/prepaid menus are charged by the restaurant, and capped per snipe |
| Model usage | via AI Gateway; a few $/mo for personal traffic |

## Security model

- Sender allowlisting happens **in code, before the model**: unknown iMessage senders and Slack users are dropped at ingress, not argued with by the prompt.
- Email content is treated as untrusted input; the persona refuses instructions embedded in mail. Outbound email is approval-gated per send.
- A **scheduled** email is authorised once, at the point it's drafted, and the row that stores it is the authorisation. The cron that sends it runs no model: recipient, subject and body are read back out and posted verbatim. That's a deliberately narrower bound than "skip approval on cron-dispatched turns" would be — that alternative constrains *when* a send may happen and nothing about *what* or *to whom*, on turns whose context routinely contains untrusted email. An interrupted send is treated as an unknown rather than a failure: Lucy checks the Sent folder before saying anything, never auto-retries, and reports "I can't tell" out loud when she can't tell.
- **A reply from someone who isn't the owner never reaches a model as a peer.** Both ingress paths drop non-owner senders in code before dispatch, so a friend cannot ask Lucy anything — she does not read it. What she does instead is relay it: they get one **fixed, model-free** line saying the owner will see it, and he gets their words quoted to him inside explicit markers, dispatched under `appAuth` rather than his own identity so nothing in the text inherits his authority. The persona treats it as the same trust class as email content, with one addition that matters more here — *never answer a question about him yourself, even one you know the answer to.* She holds his calendar, mail, memories and diary; the person asking holds a phone number he gave them. Relaying is gated on numbers he has actually texted, because the line's number is sitting on a contact card in other people's phones and "someone texted it" is not consent to interrupt him.

- **Adding a second kind of sender to an inbox silently broke the first.** The ingress poller read the newest 25 inbound messages and then filtered them to the owner. That was correct for exactly as long as the owner was the only person who ever texted the line — the moment friends could reply, their messages started consuming that window, and a busy evening would push the owner's own text out of it. He texts, nothing happens, and there is no error anywhere to notice it by. Fixed by scoping to his number server-side (`?number=`, verified honoured: a number with no history returns zero rows rather than the newest N) and keeping the client-side filter as the security boundary. `findSentText` had the same latent bug for the same reason, where a false "not found" would have told him a text hadn't sent when it had. Worth stating plainly because the bug wasn't in the new feature — it was in old code that the new feature invalidated an assumption of.

- **Texting other people is the same bargain as scheduled email, with one extra edge.** Every send is approval-gated, a scheduled one is replayed verbatim by a cron with no model in the loop, and the persona refuses to send anything arming off text that arrived from someone other than the owner. The extra edge is that the recipient is a tool argument, so a wrong one reaches a real stranger rather than bouncing: hence numbers are normalised to E.164 or **refused**, never guessed into a country code, and the owner's own number is refused outright. What is deliberately *not* claimed here: the card protects against Lucy sending something you didn't approve, not against you approving something you'll regret.
- eve's HTTP surface fails closed in production; the webhook/authorize routes require a bearer secret (timing-safe comparison).
- Google credentials never touch app env - Vercel Connect stores and refreshes the grant server-side; the app only ever sees short-lived access tokens.
- Resy login credentials are **never tool arguments**. The phone and email come from `OWNER_PHONE`/`OWNER_EMAIL`; together they are the entire credential, so nothing that talks its way into a prompt can redirect a login code to a device someone else holds. The stored session token never reaches the model - it can book, cancel, and read payment methods, so every error message is built through a redactor.
- Booking approval is **opt-out per deployment** (`RESY_AUTO_APPROVE=1`), and gated by default so a clone never books silently. Turning it off does not make booking unbounded — the seating window, deposit cap, venue guard, snipe cap and anti-double-booking claim are all enforced in code and survive it. Cancelling a reservation stays gated regardless: it's destructive and, unlike a drop, never time-critical.
- Automatic booking is **bounded in code**, not by the model's judgement. Venue, date, party size, time window and deposit cap are enforced in code at drop time: a table outside the window is refused rather than treated as close enough.
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
    reminder-poll.ts     # delivers due reminders + escalating follow-ups
    email-send.ts        # minute cron; sends pre-approved email verbatim, no
                         #   model in the loop; resolves an interrupted send by
                         #   asking Gmail rather than guessing
    text-send.ts         # minute cron; same contract for texts to other people,
                         #   resolved against Sendblue's own record of what went
    text-replies.ts      # minute cron; one fixed line back to a new correspondent,
                         #   then relays their words to the owner as untrusted data
    flight-poll.ts       # daily flight price checks, quota-aware, edge-triggered
    resy-snipe.ts        # minute cron; claims imminent drops, then sleeps to the
                         #   exact millisecond and races find -> details -> book
    resy-auth.ts         # daily; session liveness + 7/3/1-day expiry warnings
  tools/                 # reminders, memory, diary, gmail (send/reply/schedule),
                         #   texts to other people (send/schedule/list/cancel),
                         #   calendar, tasks, flights,
                         #   resy (search/availability/book/snipe/cancel)
  lib/                   # sendblue/gmail/serpapi/resy clients, tz math, supabase,
                         #   formatting; resy.ts also holds the pure ranking logic,
                         #   calendar.ts the guest-list merge rules,
                         #   outbound-text.ts the E.164 rules and the pre-card checks,
                         #   contact-card.ts the vCard builder + upload cache
scripts/
  authorize-gmail.mjs    # mints the dev-environment Google grant
  connect-resy.ts        # links Resy from the CLI (--send is opt-in; it texts you)
  check-calendar-logic.ts # pure checks: guest-list normalise/merge, duration on a move
  check-resy-logic.ts    # pure checks: slot ranking, deposit cap, DST, unit boundary
  check-resy-claim.ts    # proves two concurrent crons can't double-book a table
  check-email-claim.ts   # proves two concurrent crons can't double-send a
                         #   scheduled email; sends nothing, .invalid recipients
  check-text-claim.ts    # same for texts, plus the E.164 rules and the pre-card
                         #   checks; sends nothing, 555-0100 recipients (reserved)
  check-contact-card.ts  # vCard structure, 75-octet folding, and that the card
                         #   carries no personal number or address (--live: upload)
  set-contact-photo.ts   # installs the avatar into channel_state (never committed)
  check-resy-live.ts     # live ladder; stops before /3/book on purpose
supabase/migrations/     # schema
```

## License

MIT
