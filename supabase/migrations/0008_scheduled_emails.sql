-- Emails the owner has already approved, waiting for their moment.
--
-- WHY THIS TABLE EXISTS AT ALL. eve evaluates a tool's `approval` when the tool
-- is CALLED. So "email Bob at 9am tomorrow" through send_email means an approval
-- card at 9am tomorrow — pushed at a man who is asleep, or driving, for an email
-- he already read and said yes to the night before. once() doesn't help: it
-- keys off the current session, and a cron-dispatched turn is a new one.
--
-- So the card moves EARLIER, onto schedule_email, and this row becomes the
-- authorization. Same trade as resy_snipes next door, and the README says it the
-- same way: you approve the watch, not the booking. Here you approve the draft,
-- not the send.
--
-- ⚠️ WHAT MAKES THAT SAFE IS NOT THE CARD — it is that the sender can only
-- replay. agent/schedules/email-send.ts reads to_address/subject/body straight
-- out of this table and hands them to the same buildNewEmailRaw() the
-- interactive path uses. No model turn runs at send time, so there is nothing
-- between the approval and the wire that could compose a different email. The
-- alternative that was rejected — letting a cron-dispatched turn skip approval —
-- has a bound of "a cron started this turn", which says nothing about what gets
-- mailed to whom, and every schedule in this repo runs a model with untrusted
-- email content in its context.
create table scheduled_emails (
  id uuid primary key default gen_random_uuid(),

  -- THE AUTHORIZATION. These four are exactly what the approval card showed him,
  -- and exactly what leaves the mailbox. A discrepancy between them and the
  -- delivered message is the one bug that would make this feature untrustworthy.
  -- body is markdown, stored as he approved it and rendered at send time —
  -- storing the rendered MIME instead would freeze a formatting bug into rows
  -- that fire weeks later.
  to_address text not null,
  subject text not null,
  body text not null,
  send_at timestamptz not null,

  -- Where the "sent ✓" lands. Resolved from the VERIFIED session at arm time,
  -- never from anything the model supplied — same three columns, same reason, as
  -- reminders and resy_snipes.
  channel text not null default 'imessage' check (channel in ('imessage', 'slack')),
  phone text,
  slack_target jsonb,

  status text not null default 'scheduled'
    check (status in ('scheduled', 'sending', 'sent', 'cancelled', 'failed')),

  -- THE CLAIM. Vercel can deliver a cron twice and eve re-runs interrupted
  -- steps; here a re-run mails a person the same thing twice, from the owner's
  -- real address, which is not something you can take back. Stamped in the same
  -- UPDATE ... RETURNING that selects the row, so a duplicate invocation comes
  -- back with zero rows. Filtering on status and then writing is NOT a claim —
  -- two workers can both read 'scheduled' before either writes.
  claimed_at timestamptz,

  sent_at timestamptz,
  attempts integer not null default 0,
  last_error text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The minute cron's only query: what is due now.
create index scheduled_emails_due on scheduled_emails (send_at) where status = 'scheduled';
create index scheduled_emails_status on scheduled_emails (status);

-- RLS on, deliberately with NO policies — same as every other table here. Lucy
-- connects with the service-role key, which bypasses RLS entirely; zero policies
-- means the anon and authenticated roles can reach nothing. That matters more
-- here than for most of these tables: this one holds unsent private
-- correspondence, in full, addressed to real people.
alter table scheduled_emails enable row level security;
