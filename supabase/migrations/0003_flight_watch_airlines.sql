-- Airline filter for flight watches.
--
-- Without this a watch created from "track United nonstop EWR->NAS" silently
-- became an all-carrier watch: the search still returned a well-formed result,
-- so nothing surfaced the dropped constraint. Stored in SerpApi's
-- include_airlines form (2-char IATA codes, comma-separated, or an alliance
-- name like STAR_ALLIANCE); null means any carrier.
alter table flight_watches add column include_airlines text;

-- The airline filter is part of a watch's identity: the same route on United
-- and the same route on any carrier are different questions, and the owner is
-- entitled to track both. Recreate the uniqueness guarantee to match.
drop index flight_watches_active_uniq;

create unique index flight_watches_active_uniq
  on flight_watches (
    origin_id,
    destination_id,
    outbound_date,
    coalesce(return_date, date '1970-01-01'),
    coalesce(include_airlines, '')
  )
  where status = 'active';
