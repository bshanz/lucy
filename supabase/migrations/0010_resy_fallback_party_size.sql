-- A snipe books ONE table, but the party is sometimes negotiable: "four of us,
-- but take a two-top rather than nothing". Two armed snipes cannot express that.
-- They are independent rows, they race the same drop independently, and both can
-- win — which is two tables and two cancellation fees on a night he wanted one
-- table, on an account that gets flagged for exactly that.
--
-- So the fallback lives on the SAME row. One claim, one race, one booking, and
-- the existing UPDATE ... RETURNING claim keeps being the thing that makes a
-- double booking structurally impossible.
--
-- It also has to be tried INSIDE the drop rather than after it: at a venue that
-- may simply never publish a four-top, a fallback that only starts once the drop
-- window closes arrives after the two-tops are gone as well.
alter table resy_snipes
  add column fallback_party_size integer,
  add column booked_party_size integer;

-- A fallback that isn't smaller isn't a fallback — and one that's bigger would
-- book a table for more people than he authorised.
alter table resy_snipes add constraint resy_snipes_fallback_smaller
  check (
    fallback_party_size is null
    or (fallback_party_size >= 1 and fallback_party_size < party_size)
  );

comment on column resy_snipes.fallback_party_size is
  'Smaller party to accept when the primary size has nothing bookable inside the authorised window. Null = no fallback, take that size or nothing.';
comment on column resy_snipes.booked_party_size is
  'The size actually booked: party_size normally, fallback_party_size when it fell back. Null until something is booked.';

-- Deliberately NOT added to resy_snipes_active_unique. That index exists to stop
-- two rows racing for the same table; the fallback is a second size on one row,
-- not a second row, so the index still means what it says.
