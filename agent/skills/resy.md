---
description: Use when booking, cancelling, or sniping a restaurant table on Resy, when arming or reviewing a watch for tables that haven't been released yet, or when the Resy account needs connecting or re-authorising.
---

# Resy

`search_resy` finds a venue, `resy_availability` shows what's open now, `book_resy`
books an open table, and `snipe_resy` / `list_resy_snipes` / `cancel_resy_snipe`
handle tables that haven't been released yet. `list_resy_bookings` /
`cancel_resy_booking` manage reservations he already holds.

**Never ask your owner for a venue id.** Call `search_resy` and resolve the name
yourself, then say which one you picked — "Carbone in Manhattan, not the Miami
one" — so he can correct you. Same principle as airport codes.

Dates are `YYYY-MM-DD` and times are 24-hour `HH:MM`; you resolve both yourself
from the current time in your context. **A month is not a date and "sometime
next week" is not a date.** Offer two or three specific nights before creating
anything.

## Connecting the account

- Resy signs in with a **texted code, not a password**. If any Resy tool says
  the account isn't connected or needs re-authorising, call `connect_resy` —
  Resy texts him six digits — then ask him to send them to you and pass them to
  `verify_resy_code`.
- **Never ask him for a Resy password.** He doesn't have one. Asking sends him
  looking for something that doesn't exist.
- Do both halves in the same conversation; the code expires quickly. If it's
  rejected, call `connect_resy` again for a fresh one rather than guessing at
  digits.
- Once linked it holds for months. Say that once, briefly, then stop talking
  about tokens — he doesn't need the mechanics.
- If you're ever handed a warning that the connection is expiring or has broken,
  pass it on plainly and offer to do it there and then. Anything armed is dead
  until it's fixed, so don't bury it.

## Sniping

- A snipe is a **standing authorisation to spend his money while he's asleep**.
  The approval card — venue, date, party size, time window, deposit cap — is the
  authorisation itself, so get those bounds right before you show it, and read
  them back in plain language when you ask.
- **The time window is a hard bound, not a hint.** If he says 7–9, a 6:30 table
  is not a near miss, it's something he never agreed to, and it won't be booked.
  Ask what window he actually wants rather than guessing wide.
- **Never guess a drop time, and never make him guess either.** Resy publishes
  nothing about release times, so most of the time nobody knows it. If you *do*
  know the exact moment, pass it. If you don't, pass a **watch window**
  (`watchFromLocal` + `watchUntilLocal`) covering the likely hours — you poll
  across it and book the second tables appear. A guessed minute doesn't error,
  it just quietly loses, and he finds out the night he expected to be eating. A
  watch window can only be a few seconds late.
- When you arm a watch, say what it means in plain terms — "I'll be watching
  from 8:45 to 10:15 that morning and grab it the moment they're released" — not
  a drop time you don't actually have.
- Some venues can't be sniped at all: a few require a reCAPTCHA to book, some
  are Tock inventory wearing a Resy listing, and every venue has a party-size
  ceiling. `search_resy` tells you, and `snipe_resy` will refuse. When that
  happens **say so plainly and offer to watch it manually instead** — never
  leave him believing a table is handled when it isn't.
- **A smaller table can be a fallback, but only if he says so.** "Four of us,
  but two is better than nothing" is one snipe with `fallbackPartySize`, not
  two snipes. Two snipes race the same drop independently and can both win —
  two tables, two cancellation fees, on a night he wanted one table. The larger
  party is always tried first, and if it falls back you say so in the same
  breath as the good news: he is about to invite people to a table that seats
  fewer of them.
- Capped at 8 armed snipes. If it's full, show the list, ask which to drop,
  cancel it, then retry.
- When a snipe fires you'll be handed the result, win or lose. **Deliver both.**
  A win is a short, happy text with the restaurant, day, time and party size. A
  loss is one honest line about what happened and an offer to try the next drop
  — no drama, no double apology, and never dressed up as anything other than a
  loss.

## Booking and cancelling

- `book_resy` and `cancel_resy_booking` are approval-gated. On Slack he gets
  buttons; on iMessage, state exactly what you're about to book or cancel and
  wait for a clear yes.
- **Deposits: assume zero unless he says otherwise.** The tools refuse any table
  needing a card unless he's cleared an amount. If one comes back over the
  limit, tell him the exact number and ask — don't quietly book it and don't
  quietly skip it.
- **Never say a table is booked without a confirmation from a tool call in this
  turn.** No "you're all set" on the strength of having called `snipe_resy` —
  that only arms it.
- If he mentions he can't make a reservation, offer to cancel it. A no-show
  costs him a fee and can get his Resy account suspended, and it leaves a table
  empty that somebody else wanted.
