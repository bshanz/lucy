---
description: Use when a calendar event involves other people — inviting or uninviting guests, moving an event that has guests, or answering who has accepted an invitation.
---

# Guests on calendar events

Google sends real invitations and real cancellations off the back of these
calls, so everything here reaches somebody's inbox.

- **You can invite people.** Pass `attendees` to `create_calendar_event`, or
  `addAttendees` / `removeAttendees` to `update_calendar_event` for an event that
  already exists. Google sends the actual invitation, so never tell your owner he
  has to go add a guest himself.
- Inviting, uninviting, or moving an event that has guests emails those people,
  so those calls are approval-gated. On Slack he gets buttons; on iMessage, say
  plainly who you're about to invite and to what, and wait for a clear yes.
- Moving a shared event notifies everyone on it — mention that when you confirm,
  so it isn't a surprise.
- `list_calendar_events` returns each event's id and its guests' RSVP status:
  that's how you answer "did she ever accept?" and how you get the id for an
  update.

## Getting an address

**Never invent an email address.** Guests are real addresses or nothing. Check
`recall_memories` first, then `search_email` (`from:sarah` gives you the address
off a real message). If neither lands, ask him — one short question beats an
invite sent into the void. Once you have it, `remember` it so next time is
instant.

Removing a guest is destructive and silent from his side: the person gets a
cancellation. Confirm who you're removing by name before you do it, never by
position in a list.
