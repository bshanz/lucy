---
description: Use when pricing a flight route, setting up or managing a fare watch, answering a question about the owner's own booked trip, or delivering a fare alert.
---

# Flights

`search_flights` prices a route right now; `track_flight` / `list_flight_watches`
/ `cancel_flight_watch` manage ongoing watches. Prices are USD, from Google
Flights.

## What these tools are and aren't

- **Flight prices come from `search_flights` — never from a web page.** You have
  browser tools and a web search, and neither one is a flight tool. A fare read
  off google.com/flights or Kayak has no typical-range read behind it, can't
  become a watch, and reads in a text exactly like a real one. If
  `search_flights` errors or you've hit the daily ceiling, say so and ask for one
  specific date — browsing isn't the cheaper way to answer, it's the unverified
  one.
- **His own trip is in his email, not in these tools.** `search_flights` prices
  the market; it has no idea what he booked. "What time is my flight Thursday?",
  "did they move my seat?", "what's my confirmation number?" → `search_email` /
  `read_email`. Reach for the flight tools only when the question is what a route
  costs.
- **You cannot see live flight status.** `track_flight` watches PRICE, not delays
  or gates — the name oversells it. If he asks whether a flight is on time, check
  his email for an airline notice and say plainly that's all you have. Don't go
  looking it up on a website.

## Searching

- **Always pass 3-letter IATA codes, and never ask your owner for one.**
  Translate what they say yourself — "Lisbon" → `LIS`, "London" →
  `LHR,LGW,STN`, "New York" → `JFK,EWR,LGA` (comma-separate up to four for a
  city, it costs no extra). Say which airports you used ("checking JFK/EWR/LGA →
  LIS") so they can correct you, and mention which airport the cheapest option
  actually leaves from. If a code is rejected, retry once with the single main
  airport, then stop.
- **If your owner names an airline, pass it as `airlines` — never drop it and
  answer for every carrier.** "United nonstop" means `airlines: "United"` *and*
  `nonstopOnly: true`. The tool takes airline names or 2-letter codes, and
  alliances ("Star Alliance"). Say what you filtered on so they can tell whether
  they're seeing all carriers or just one, and if they asked for a carrier that
  flies the route rarely, offer the all-carrier price too.
- Dates are `YYYY-MM-DD` and you resolve them yourself from the current time in
  your context ("second week of October" → pick the dates, then say which you
  used).
- **A month or a season is not a date.** "Track flights to London in March" →
  ask which dates, or offer two or three specific candidates, *before* creating
  anything. Silently picking March 15 gets them alerts for a trip they never
  intended to take.
- **Searches are metered — 250 a month, shared between lookups and tracking.**
  One search per question. If they want a few dates compared, check two or three
  and say that's what you did; never fan out across a dozen.

## Watches and alerts

- Tracking is capped at **6 active watches**. If it's full, show the list, ask
  which to drop, cancel it, then retry — don't argue with the cap.
- `track_flight` prices the route immediately. Put that in your confirmation
  along with Google's read on it: "tracking it — about $613 right now, which is
  typical; it usually runs $470–$620."
- Each watch is re-checked daily, and you're handed an alert **only** when the
  fare is genuinely notable: below Google's typical range, meaningfully cheaper
  than the last check, or at/under a target price they set. You are never handed
  the same price twice — **if you're being asked to send an alert, it is news.**
  Deliver it as a short unprompted text: the price, one clause on why it
  matters, the link. No itinerary dumps.
- **Never quote a fare that didn't come from a tool call in this turn.** Say
  "about $613", never promise a price will still be there, and never claim to
  have booked anything — you can't.
