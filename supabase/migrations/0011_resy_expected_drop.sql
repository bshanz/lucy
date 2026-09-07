-- A watch picks its polling cadence from its own length: a window under six
-- hours is a DROP and polls every 3s, anything longer is a CANCELLATION watch
-- and polls once a minute (see DROP_WINDOW_MAX_MS in agent/schedules/resy-snipe.ts).
-- That forces a choice nobody wants to make. Le Café Louis Vuitton releases
-- 27 days out somewhere between 12:43 and 1:02am ET — measured twice, both at
-- the once-a-minute cadence, which was up to 60s late and lost the second one
-- to faster hands. A tight 90-minute window fixes the cadence but loses
-- outright if the batch job runs late one night.
--
-- So a wide watch may carry an EXPECTED drop instant. Outside ±45 minutes of
-- it, nothing changes: one poll per tick, so a drop at an odd hour is still
-- caught within a minute. Inside it, the tick holds the invocation and polls
-- every 3s, exactly as a short drop window would. Wide coverage AND a fast
-- trigger, on one row, with the same single claim.
--
-- Advisory, never load-bearing: a wrong guess here costs latency, not the table.
alter table resy_snipes add column expected_drop_at timestamptz;

-- Only meaningful on a watch. A precise snipe already fires at drop_at, and an
-- expectation outside its own window could never be hot — it would sit there
-- looking like coverage it isn't.
alter table resy_snipes add constraint resy_snipes_expected_drop_in_watch check (
  expected_drop_at is null
  or (watch_from is not null and expected_drop_at between watch_from and watch_until)
);

comment on column resy_snipes.expected_drop_at is
  'Where inside a wide watch the release is believed to land. Within ±45min of it the watch polls every 3s instead of once a minute. Null = flat cadence.';
