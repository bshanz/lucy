-- Confirm a reminder actually reached the owner before calling it sent.
--
-- reminder-poll marked a reminder 'sent' the moment receive() returned. That
-- return means "the session accepted this message", NOT "the owner has it" —
-- and a parked eve session accepts messages happily: it queues them behind an
-- unanswered input request and never speaks again.
--
-- On 2026-08-22 that cost a real reminder. The iMessage session crossed eve's
-- per-session input-token limit and parked on the Approve/Stop continuation
-- prompt; because the session's durable run was pinned to a deployment that
-- predated the channel's input.requested handler, the prompt was never rendered
-- and nothing was texted. reminder-poll dispatched "Cancel the endoscopy", saw
-- receive() return cleanly, wrote status='sent', stamped sent_at and armed the
-- 24h follow-up curve. The row claimed delivered. The phone had nothing on it.
-- Nothing anywhere in the stack raised an error.
--
-- receive() cannot be awaited into a delivery guarantee: it resolves well before
-- the model composes anything. Measured on the repaired session — dispatched
-- 13:22:41Z, text on the wire 13:22:48Z. So confirmation has to be a second
-- pass, and that means a reminder needs a state for "handed off, not yet seen
-- leaving".

alter table reminders drop constraint if exists reminders_status_check;
alter table reminders add constraint reminders_status_check
  check (status in (
    'pending', 'sending', 'awaiting_delivery', 'sent', 'done', 'cancelled', 'lapsed'
  ));

-- When the dispatch now awaiting confirmation was handed to the agent.
-- Deliberately distinct from sent_at, which goes back to meaning what it always
-- claimed to: the moment a message was OBSERVED leaving for the owner. The
-- follow-up curve hangs off sent_at, so keeping the two apart is exactly what
-- stops a swallowed reminder from arming nudges for a text that never existed.
alter table reminders add column dispatched_at timestamptz;

-- Consecutive dispatches never seen to land. Drives retry backoff, resets on
-- confirmation. A wedged session should be retried patiently and complained
-- about loudly, never abandoned quietly — quiet abandonment is the bug here.
alter table reminders add column delivery_attempts int not null default 0;

create index reminders_delivery_idx on reminders (status, dispatched_at);
