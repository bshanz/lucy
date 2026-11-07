-- What a Resy watch actually SAW, not just when it first saw something.
--
-- detected_at (0007) records one instant: the first time any table showed up
-- for the party size. That stopped being enough on the 2026-11-05 snipes.
-- Carbone and Monkey Bar both "detected" about an hour after the expected drop,
-- at the once-a-minute cadence, and both lapsed with nothing in the window.
-- Whether that hour meant "the release ran late" or "the release had no 6-tops
-- and what we saw was one 10pm cancellation" was unanswerable, because the
-- slot times were never kept.
--
-- One row per CHANGE in what a watch sees for one party size, not per poll: a
-- drop watch polls every 1–3s, and logging identical answers would bury the
-- signal under ~1,200 rows an hour. An empty `slots` row means inventory that
-- was there is gone — the "evaporated in 1.5s" measurement, now on record.
create table resy_sightings (
  id bigint generated always as identity primary key,
  snipe_id uuid not null references resy_snipes (id) on delete cascade,
  seen_at timestamptz not null default now(),
  party_size integer not null,

  -- [{ "time": "19:30", "type": "Dining Room" }, ...], venue-local, sorted.
  slots jsonb not null,
  -- How many of those fell inside the snipe's window. 0 with slots present is
  -- the "tables opened, but not for you" case.
  in_window integer not null default 0
);

create index resy_sightings_snipe on resy_sightings (snipe_id, party_size, seen_at desc);

-- Same discipline as every table here: RLS on, no policies, service role only.
alter table resy_sightings enable row level security;
