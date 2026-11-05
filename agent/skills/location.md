---
description: Use when the owner asks for a reminder tied to a place ("when I get home", "when I leave work", "every time I get to the gym"), asks where he is or when he got somewhere, or when create_reminder returns needsSetup.
---

# Location reminders

You don't track his location. His iPhone does: an iOS Shortcuts automation for
each place pings you when he arrives or leaves, and that ping fires any
reminder waiting on it, usually within a minute.

## Making one

- "When I get home, remind me to…" → `create_reminder` with `place: "home"`,
  `on: "arrive"`, and **no `fireAtLocal`**. "When I leave work" → `on: "leave"`.
- Never turn a place into a guessed time ("you usually get home at 6, so 6pm").
  If he wanted a time he'd have said one.
- "Every time I get home…" → `recurrence: "each_time"`. A plain one fires once,
  then it's an ordinary reminder with the normal follow-up nudges.
- Use short, stable place names: `home`, `work`, `gym`. The name has to match
  the `place` his Shortcut sends, so reuse a name from `where_am_i` if one fits.
- Confirm casually: "Got it, I'll remind you when you get home."

## When `needsSetup` comes back

His phone has never reported that place, so the reminder is saved but nothing
will fire it yet. Say so in the same reply, plainly, and offer the steps. Don't
dump them unless he says yes. When he does, send this (fill in the place and
event):

1. Shortcuts app → Automation → + → **Arrive** (or **Leave**) → pick the
   location → **Run Immediately** → Next → New Blank Automation.
2. Add **Get Contents of URL**: `https://heylucy.vercel.app/location/event`
   - Method **POST**, Request Body **JSON**: `place` = `home`, `event` = `arrive`
   - Headers: `Authorization` = `Bearer <your Lucy secret>`, and
     `x-vercel-protection-bypass` = `<your Vercel bypass secret>`
3. Turn off "Notify When Run". Then tap the automation once to test it, and
   ask `where_am_i` to confirm the ping landed.

Never put the actual secrets in a text. He has them; refer to them by name.
One automation covers one place and one direction. Arriving home and leaving
home are two separate automations.

## Where is he?

`where_am_i` returns the last arrive/leave ping for each place. It's the most
recent geofence event, not live GPS: "you got home at 6:12" is right, and
"you're at home right now" is only a good guess. If the last ping is old or
says he left, say what you actually know.
