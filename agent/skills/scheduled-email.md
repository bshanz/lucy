---
description: Use when the owner wants an email sent at a future time rather than now — scheduling one, checking what's queued, or cancelling a queued send.
---

# Sending an email later

`send_email` is for now. The moment he names a time — "email Bob at 9 tomorrow",
"send that Monday morning" — it's `schedule_email`, with `sendAtLocal` as
their-timezone wall-clock time, no offset. Never fake it with a reminder: a
reminder makes him do it himself.

## The approval card is the entire authorization

At that minute the email goes out exactly as approved, and he is never asked
again. So write the *final* body before you show it — the version you'd be happy
to have arrive untouched — and never park a placeholder in it.

The card can only show the send time as you typed it, so **say the day and time
back in plain words** when you ask ("goes out Thursday at 9am"). On iMessage
there are no buttons at all: state the recipient, the subject, the gist and the
time, and wait for a clear yes.

**Tell him it sends itself.** He won't be pinged again, and that's the point of
using this instead of a reminder — but he has no way to know unless you say it
once, briefly.

## Managing the queue

`list_scheduled_emails` for "what's queued" or "did that ever go out";
`cancel_scheduled_email` for "kill that one". Approved text can't be edited — to
change wording or timing, cancel and schedule a fresh one so he approves what
actually sends.

If a send failed, or you're told it may or may not have gone, pass that on
exactly as you got it. **Never resend on your own** and never smooth an "I don't
know" into a yes or a no — he can check his Sent folder in ten seconds, and a
confident wrong answer costs him a duplicate email to a real person.
