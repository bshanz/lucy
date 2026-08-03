-- Escalating reminder follow-ups: 24h, then +48h, then +96h, then stop asking.
--
-- The old design was one boolean nudge and then permanent silence, which left
-- every ignored reminder parked at status='sent' forever — and list_reminders'
-- 'awaiting_confirmation' filter selects exactly that, so the model's view of
-- "what's still open" accumulated every reminder the owner had ever let slide.
--
-- A boolean can't express how many nudges have gone out or when the next one is
-- due, so it becomes a counter plus an explicit deadline. The deadline is the
-- more important half: it turns the follow-up claim into the same
-- filter-then-claim shape as the due-reminder claim beside it in reminder-poll,
-- instead of arithmetic on sent_at inside the query.
--
-- 'lapsed' is the terminal state for a reminder that outlived the curve. It
-- means "stop texting about this", NOT "stop tracking it" — lapsed reminders
-- still list, and can still be completed, rescheduled, or cancelled by name.

alter table reminders drop constraint if exists reminders_status_check;
alter table reminders add constraint reminders_status_check
  check (status in ('pending', 'sending', 'sent', 'done', 'cancelled', 'lapsed'));

alter table reminders add column follow_up_count int not null default 0;
alter table reminders add column next_follow_up_at timestamptz;

-- A spent boolean means nudge #1 already went out.
update reminders set follow_up_count = 1 where followed_up;

-- Place every open one-off on the new curve at the first offset still in the
-- future. Deliberately not backdating: a reminder whose 24h mark passed months
-- ago picks up at the next offset it hasn't blown through, so shipping this
-- doesn't fire a backlog of nudges in the same minute.
update reminders set next_follow_up_at =
  case
    when follow_up_count < 1 and sent_at + interval '24 hours'  > now() then sent_at + interval '24 hours'
    when follow_up_count < 2 and sent_at + interval '72 hours'  > now() then sent_at + interval '72 hours'
    when follow_up_count < 3 and sent_at + interval '168 hours' > now() then sent_at + interval '168 hours'
  end
where status = 'sent' and recurrence is null and sent_at is not null;

-- Anything with no offset left is exactly what 'lapsed' is for.
update reminders set status = 'lapsed'
where status = 'sent' and recurrence is null and next_follow_up_at is null;

-- Index first, then the column. Postgres cascades an index away with any column
-- it references, so dropping the column first would silently take
-- reminders_followup_idx with it and leave the explicit drop below erroring on
-- an index that no longer exists.
drop index reminders_followup_idx;
alter table reminders drop column followed_up;

create index reminders_followup_idx on reminders (status, next_follow_up_at);
