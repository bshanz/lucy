-- Watch-mode snipes: fire when inventory ACTUALLY appears, not at a guessed second.
--
-- Resy publishes no booking-window metadata (/3/venue 400s, the search payload
-- says nothing about release times), so a venue's drop time can only be learned
-- by watching one happen. Every published figure is hearsay, and a snipe armed
-- for the wrong minute does not error — it polls an empty window, reports a
-- clean miss, and the table is gone. That failure is silent and total.
--
-- So a snipe is now one of two shapes:
--
--   drop_at                  — the exact instant, when it is genuinely known.
--                              Precise to the millisecond; the pre-warm pays off.
--   watch_from / watch_until — a window to watch. The cron polls inside its own
--                              invocation and races the moment the horizon
--                              extends. Detection costs a few seconds versus a
--                              known drop_at, which is a rounding error against
--                              being an hour wrong.
--
-- Exactly one shape per row, enforced below rather than by convention: a row
-- with both would be ambiguous about when to fire, and a row with neither would
-- sit armed forever.
alter table resy_snipes alter column drop_at drop not null;

alter table resy_snipes add column watch_from timestamptz;
alter table resy_snipes add column watch_until timestamptz;

alter table resy_snipes add constraint resy_snipes_timing_shape check (
  (drop_at is not null and watch_from is null and watch_until is null)
  or
  (drop_at is null and watch_from is not null and watch_until is not null
   and watch_from < watch_until)
);

-- Watch-mode rows are leased, not consumed: a worker claims one for its minute,
-- polls, and on finding nothing lets the lease lapse so the next tick retries.
-- Without a lease two concurrent crons would both poll the same row and could
-- both reach /3/book — which is the double-booking this table exists to prevent.
-- `fired_at` doubles as that lease; it already means "a worker took this".
create index resy_snipes_watching
  on resy_snipes (watch_from, watch_until)
  where status = 'armed' and watch_from is not null;
