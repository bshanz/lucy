-- Location-triggered reminders: "remind me to take the trash out when I get home".
--
-- Lucy has no idea where the owner is. His phone does: an iOS Shortcuts
-- personal automation ("When I Arrive Home", Run Immediately) POSTs
-- { place, event } to /location/event. The geofence lives on the phone; the
-- server only ever hears a place NAME and whether he arrived or left.
--
-- A location reminder is an ordinary reminders row with fire_at NULL and a
-- trigger. The ping stamps fire_at = now() on the matching rows and walks away;
-- reminder-poll then delivers them through the normal path. That is the whole
-- design: delivery confirmation, follow-up nudges, list/cancel/complete — none
-- of it had to learn that a reminder can be anchored to a place instead of a
-- clock, because by the time the poller sees the row it IS anchored to a clock.
--
-- The due query is `status = 'pending' and fire_at <= now()`, and NULL never
-- satisfies <=, so an unarmed location reminder is invisible to the poller
-- without any change to it.

alter table reminders alter column fire_at drop not null;

-- Normalized place key ('home', 'work', 'gym') — the same string the Shortcut sends.
alter table reminders add column trigger_place text;
alter table reminders add column trigger_event text
  check (trigger_event in ('arrive', 'leave'));

-- Every reminder is anchored to SOMETHING. A row with neither would sit in
-- 'pending' forever, listing as upcoming and never firing.
alter table reminders add constraint reminders_anchor_check
  check (fire_at is not null or trigger_place is not null);
alter table reminders add constraint reminders_trigger_pair_check
  check ((trigger_place is null) = (trigger_event is null));

create index reminders_trigger_idx on reminders (status, trigger_place, trigger_event)
  where trigger_place is not null;

-- Places the phone has actually reported, and the last thing it said about
-- each. A row appears the first time a Shortcut pings, which is how Lucy knows
-- whether "when I get to the gym" will ever fire (no row = no automation) and
-- how she answers "am I home?".
create table places (
  key text primary key,
  label text not null,
  last_event text check (last_event in ('arrive', 'leave')),
  last_event_at timestamptz,
  created_at timestamptz not null default now()
);
alter table places enable row level security;
