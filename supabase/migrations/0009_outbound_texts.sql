-- Texts Lucy sends to people who are not the owner: the queue for the ones he
-- approved for later, and the log of the ones already gone.
--
-- WHY THIS TABLE EXISTS AT ALL. The same reason scheduled_emails does next door:
-- eve evaluates a tool's `approval` when the tool is CALLED, so "text Alex at 8am"
-- through send_text would card him at 8am — for a message he wrote and said yes to
-- the night before. once() doesn't help; it keys off the current session and a
-- cron-dispatched turn is a new one. So the card moves EARLIER, onto schedule_text,
-- and this row becomes the authorization.
--
-- ⚠️ WHAT MAKES THAT SAFE IS NOT THE CARD — it is that the sender can only replay.
-- agent/schedules/text-send.ts reads to_number and body straight out of this table
-- and hands them to sendMessage(). No model turn runs at send time, so there is
-- nothing between the approval and the wire that could compose a different message
-- to a different person.
--
-- WHY ONE TABLE AND NOT TWO. Immediate sends from send_text land here too, already
-- marked 'sent'. That is what makes "have I ever texted this number?" a single
-- indexed query — which is what decides whether the message opens with the line
-- identifying the owner, since these arrive from Lucy's Sendblue line and not from
-- his own number. A separate contacts table would be a second thing to keep true.
create table outbound_texts (
  id uuid primary key default gen_random_uuid(),

  -- THE AUTHORIZATION. These three are exactly what the approval card showed him
  -- and exactly what leaves the line. body is stored POST-formatting and
  -- POST-intro-line: whatever transformation the message needs has already
  -- happened by the time it is written here, so that the bytes on the card, the
  -- bytes in this column, and the bytes his friend receives are the same bytes.
  -- (scheduled_emails stores markdown and renders at send time, which it can
  -- afford because rendering an email is deterministic and reversible. Prepending
  -- a sentence is neither.)
  to_number text not null,
  body text not null,
  send_at timestamptz not null,

  -- Where the "sent ✓" lands — the OWNER's channel, not the recipient's. Resolved
  -- from the VERIFIED session at arm time, never from anything the model supplied:
  -- same three columns, same reason, as reminders and scheduled_emails.
  channel text not null default 'imessage' check (channel in ('imessage', 'slack')),
  phone text,
  slack_target jsonb,

  status text not null default 'scheduled'
    check (status in ('scheduled', 'sending', 'sent', 'cancelled', 'failed')),

  -- THE CLAIM. Vercel can deliver a cron twice and eve re-runs interrupted steps;
  -- here a re-run texts a real person the same thing twice. Stamped in the same
  -- UPDATE ... RETURNING that selects the row, so a duplicate invocation comes back
  -- with zero rows. Filtering on status and then writing is NOT a claim — two
  -- workers can both read 'scheduled' before either writes.
  claimed_at timestamptz,

  sent_at timestamptz,

  -- Sendblue's canonical id for the delivered message, when we got one back. This
  -- is what makes "did that actually land?" answerable later without guessing.
  message_handle text,

  attempts integer not null default 0,
  last_error text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The minute cron's only query: what is due now.
create index outbound_texts_due on outbound_texts (send_at) where status = 'scheduled';

-- The first-contact lookup, on every single send. Partial on 'sent' because a
-- queued or failed text is not evidence that this person has heard from him.
create index outbound_texts_sent_to on outbound_texts (to_number) where status = 'sent';

create index outbound_texts_status on outbound_texts (status);

-- RLS on, deliberately with NO policies — same as every other table here. Lucy
-- connects with the service-role key, which bypasses RLS entirely; zero policies
-- means the anon and authenticated roles can reach nothing. As with
-- scheduled_emails, this one holds private correspondence with real people, in
-- full, alongside their phone numbers.
alter table outbound_texts enable row level security;
