-- Flight price tracking (SerpAPI / Google Flights). One row = one watched
-- route + date pair.
--
-- The daily poller spends exactly ONE metered SerpAPI search per active row per
-- day, so the active row count IS the monthly quota budget: 6 x 31 = 186 of the
-- free tier's 250, leaving ~64 for ad-hoc search_flights lookups. The 6-watch
-- cap is enforced in agent/tools/track_flight.ts, which is why there is no cap
-- here.
--
-- Delivery columns mirror the reminders table so an alert lands wherever the
-- watch was created.
create table flight_watches (
  id uuid primary key default gen_random_uuid(),

  channel text not null default 'imessage' check (channel in ('imessage', 'slack')),
  phone text,                                  -- imessage target
  slack_target jsonb,                          -- slack target ({ "channelId": ... })

  -- Two forms of the route: what the owner said, and what we send to SerpAPI
  -- (uppercase IATA, comma-separated for multi-airport cities: 'JFK,EWR,LGA').
  -- Storing both makes a wrong airport resolution visible with no API call.
  origin_query text not null,
  destination_query text not null,
  origin_id text not null,
  destination_id text not null,

  outbound_date date not null,
  return_date date,                            -- null => one way => SerpAPI type=2
  currency text not null default 'USD',        -- explicit, so a default change is visible

  adults integer not null default 1 check (adults between 1 and 9),
  travel_class integer not null default 1      -- 1 economy, 2 premium, 3 business, 4 first
    check (travel_class between 1 and 4),
  stops integer not null default 0             -- 0 any, 1 nonstop, 2 <=1 stop, 3 <=2 stops
    check (stops between 0 and 3),

  -- Whole USD; Google Flights never quotes cents. Compare integers, never floats.
  target_price integer check (target_price is null or target_price > 0),
  baseline_price integer,                      -- price when the watch was created
  last_price integer,                          -- updated EVERY poll, alert or not
  last_price_at timestamptz,

  -- Alert SUPPRESSION state, deliberately separate from the OBSERVATION state
  -- above. Conflating them makes the drop calculation measure "change since I
  -- last texted" instead of "change since I last looked", which swallows
  -- gradual declines. null alerted_price = armed. See evaluateAlert() in
  -- agent/lib/flights.ts for the full state machine.
  alerted_price integer,
  alerted_at timestamptz,

  -- Owner-local date of the last poll. This is the atomic claim: the poller
  -- stamps today's date in one UPDATE ... RETURNING before it spends a search,
  -- so a duplicate cron delivery or a re-run of an interrupted step gets zero
  -- rows and does nothing. Also self-heals a silently missed day.
  checked_on date,
  last_checked_at timestamptz,
  last_error text,
  consecutive_errors integer not null default 0,

  -- active -> paused (3 straight failures) | expired (departure near) | cancelled (owner)
  status text not null default 'active'
    check (status in ('active', 'paused', 'expired', 'cancelled')),
  paused_reason text,
  created_at timestamptz not null default now(),

  constraint flight_watches_date_order check (return_date is null or return_date >= outbound_date)
);

-- Matches the poller's claim predicate exactly.
create index flight_watches_due_idx on flight_watches (status, outbound_date, checked_on);

-- One active watch per route + dates. track_flight pre-checks for the friendly
-- message; this is the guarantee. coalesce keeps one-way rows comparable
-- (null <> null in a plain unique index would allow duplicates).
create unique index flight_watches_active_uniq
  on flight_watches (origin_id, destination_id, outbound_date, coalesce(return_date, date '1970-01-01'))
  where status = 'active';

alter table flight_watches enable row level security;
