-- Resy reservations: credential storage + armed reservation snipes.
--
-- Resy has no public API. Lucy talks to the same JSON API the web app uses, on
-- the owner's own account. Login returns a 45-day auth token and a 90-day
-- refresh token, which is why there is no browser session to persist here — the
-- refresh token outlives any cookie jar and, unlike one, renews from a cron.

-- One row, forever. The `id boolean primary key check (id)` trick makes a second
-- row impossible at the schema level rather than by convention: a bug that
-- inserts instead of updating would otherwise leave two tokens, and whichever
-- one a query happened to return would decide whether booking worked that day.
create table resy_credentials (
  id boolean primary key default true check (id),

  -- ⚠️ The auth token IS the account: it can book, cancel, and read payment
  -- methods. It must never reach a tool return value or a log line — see the
  -- redact() discipline in agent/lib/resy.ts. The owner's PASSWORD is
  -- deliberately absent from this table; it lives only in env and is exchanged
  -- for these tokens at most once every 45 days.
  auth_token text not null,
  refresh_token text,

  -- Decoded from the JWT `exp` when present, null for opaque tokens. Nullable
  -- rather than defaulted: a guessed expiry that runs long strands every armed
  -- snipe at T-0, which is exactly when nobody is watching.
  auth_expires_at timestamptz,
  refresh_expires_at timestamptz,

  last_refreshed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- One row = one armed snipe: a specific table, at a specific venue, on a
-- specific night, that Lucy is pre-authorized to book unattended.
--
-- The trust model matches flight_watches: the owner approves the WATCH, and the
-- cron acts alone inside its bounds. The difference is that a flight alert costs
-- a text message and this costs a real reservation with a real cancellation fee,
-- so the bounds here are enforced in code (see rankSlots / depositWithinBounds)
-- rather than being advisory.
create table resy_snipes (
  id uuid primary key default gen_random_uuid(),

  -- Delivery target, copied from flight_watches so an outcome lands wherever the
  -- snipe was created. Resolved from the verified session at insert time, never
  -- from anything the model supplied.
  channel text not null default 'imessage' check (channel in ('imessage', 'slack')),
  phone text,
  slack_target jsonb,

  -- What to book. venue_name/slug are denormalised so list_resy_snipes and the
  -- outcome text read correctly without a network call — a snipe that fires at
  -- 9am shouldn't need Resy to be up just to say which restaurant it was.
  venue_id integer not null,
  venue_name text not null,
  venue_slug text,
  reservation_date date not null,
  party_size integer not null check (party_size between 1 and 20),

  -- The pre-authorized bounds. These are exactly what the approval card showed
  -- the owner, which makes them the authorization itself — a booking outside
  -- them is something he never agreed to, not a near miss.
  earliest_time time not null,
  latest_time time not null,
  preferred_time time,
  slot_types text[],                  -- ranked; null = any table is fine
  max_deposit_cents integer not null default 0 check (max_deposit_cents >= 0),

  -- The exact instant inventory publishes. Resolved in the OWNER's timezone at
  -- arm time and shown on the approval card, so a wrong one is caught by a human
  -- before it matters rather than by a silent miss.
  drop_at timestamptz not null,

  status text not null default 'armed'
    check (status in ('armed', 'firing', 'booked', 'missed', 'failed', 'cancelled')),

  -- THE CLAIM. Stamped in the same UPDATE ... RETURNING that selects the row.
  -- Vercel can deliver a cron twice and eve re-runs interrupted steps; here a
  -- re-run would book the same table twice, with two cancellation fees, on an
  -- account that gets flagged for exactly that. A duplicate invocation must come
  -- back with zero rows. Filtering on status alone is NOT a claim — two workers
  -- can both read 'armed' before either writes.
  fired_at timestamptz,

  -- Outcome. resy_token is the handle needed to cancel, so it is genuinely
  -- needed here; it is scoped to one reservation and cannot book anything new.
  resy_token text,
  reservation_id text,
  booked_time time,
  booked_slot_type text,
  deposit_paid_cents integer,

  attempts integer not null default 0,
  last_error text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Time windows that can never match would sit armed and lose silently.
alter table resy_snipes add constraint resy_snipes_window_ordered
  check (earliest_time <= latest_time);
alter table resy_snipes add constraint resy_snipes_preferred_in_window
  check (preferred_time is null or preferred_time between earliest_time and latest_time);

-- Two armed snipes for the same table are a double booking waiting to happen.
-- Partial, so a cancelled or completed snipe never blocks re-arming the same
-- venue and night next month.
create unique index resy_snipes_active_unique
  on resy_snipes (venue_id, reservation_date, party_size)
  where status in ('armed', 'firing');

-- The minute cron's only query: what fires in the next ~90 seconds.
create index resy_snipes_due on resy_snipes (drop_at) where status = 'armed';
create index resy_snipes_status on resy_snipes (status);

-- RLS on, deliberately with NO policies — same as every other table here. Lucy
-- connects with the service-role key, which bypasses RLS entirely; zero policies
-- means the anon and authenticated roles can reach nothing. Skipping this would
-- leave resy_credentials readable by anyone holding the project's anon key, and
-- that row is not a preference — it is a token that can book and cancel on the
-- owner's account and read his payment methods.
alter table resy_credentials enable row level security;
alter table resy_snipes enable row level security;
