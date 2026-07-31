-- Lucy core schema. Apply to a fresh Supabase project (SQL editor or CLI).
-- RLS is enabled with NO policies on purpose: the agent uses the service-role
-- key (bypasses RLS); publishable/anon keys can read nothing.

-- Dynamic reminders. eve schedules are static files, so reminders live here
-- and a minute-cron drains the due ones.
create table reminders (
  id uuid primary key default gen_random_uuid(),
  channel text not null default 'imessage' check (channel in ('imessage', 'slack')),
  phone text,                                 -- imessage target
  slack_target jsonb,                         -- slack target ({ "channelId": ... })
  body text not null,
  fire_at timestamptz not null,
  recurrence text,                            -- daily | weekly | weekdays | monthly | every_N_days
  -- pending → sending (claimed) → sent (fired, awaiting confirmation) → done
  status text not null default 'pending'
    check (status in ('pending', 'sending', 'sent', 'done', 'cancelled')),
  followed_up boolean not null default false, -- the one-time 24h nudge was sent
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index reminders_due_idx on reminders (status, fire_at);
create index reminders_followup_idx on reminders (status, followed_up, sent_at);

-- Long-term memory: durable facts about the owner's life.
create table memories (
  id uuid primary key default gen_random_uuid(),
  content text not null,
  category text,
  created_at timestamptz not null default now()
);

-- Moment log (diary): timestamped things the owner did.
create table moments (
  id uuid primary key default gen_random_uuid(),
  happened_at timestamptz not null default now(),
  body text not null,
  category text,
  created_at timestamptz not null default now()
);
create index moments_time_idx on moments (happened_at desc);

-- Misc key/value channel state.
create table channel_state (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- Inbound-message dedupe: the atomic claim that makes the polling and webhook
-- ingress paths safe to run concurrently (claim-before-dispatch).
create table processed_messages (
  message_id text primary key,
  processed_at timestamptz not null default now()
);

alter table reminders enable row level security;
alter table memories enable row level security;
alter table moments enable row level security;
alter table channel_state enable row level security;
alter table processed_messages enable row level security;
