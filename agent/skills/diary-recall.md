---
description: Use when answering a question about what the owner has done — counting or tallying past moments ("how many drinks this month", "how often do I skip the gym"), or looking anything up in his diary by category rather than by his exact words.
---

# Reading the diary

`recall_moments` searches the moment log. The whole skill is one problem:
**the diary stores his wording, and questions arrive as categories.**

He writes `had 2 dirty martinis`. He asks `how many drinks this month`. The
word "drinks" appears in none of his entries, and nothing bridges that gap
automatically.

## Keywords are literal substrings

`query` matches text inside the body. It is not semantic. `"drinks"` does not
match `"had 2 dirty martinis"`, `"three Bellinis"`, or `"a negroni at Dante"`.

So:

- **Category question** ("what have I been drinking?") → pass `query` as a
  **list** of the words he'd plausibly have typed:
  `["drink","martini","wine","beer","cocktail","negroni","bellini"]`.
  Any one matching is a hit.
- **Counting question** ("how many X this month?") → pull the **whole window
  with no `query` at all** and count the entries yourself. A concept the diary
  never names cannot be counted by matching on its name, and a partial keyword
  list silently undercounts — which reads exactly like a correct answer.
- **Open question** ("what did I do last weekend?") → window, no query,
  summarize.

## Zero matches is never "that never happened"

An empty result tells you those *words* don't appear. It says nothing about
whether the thing happened. Reporting it as "nothing logged" is a confident,
specific, false statement about his own life — the worst failure this
assistant has.

If a keyword search comes back empty: widen the list, or drop the query and
read the window. Only say nothing is logged when you have looked at the window
and it is genuinely empty.

## The tool tells you when it fell back

If a keyword search matches nothing but the window has entries, `recall_moments`
returns `matchedKeyword: false`, a `note`, and **every moment in the window**
instead. That is not a match list — it is the raw window handed to you because
your words missed. Read the entries and decide yourself which ones count.

## The one series that IS structured

The nightly healthy-eating check-in writes a fixed body — `Healthy eating: yes`
or `Healthy eating: no`, category `health` — precisely so it escapes everything
above. "How many clean days this month?" is a literal query for
`["Healthy eating: yes"]`, and it is exact.

Two cautions. A day with no entry means he never answered, **not** that he ate
badly — report the denominator you actually have ("14 of the 19 nights you
answered"). And any colour he added lives in a separate moment with his own
wording, so it is subject to the keyword problem like everything else.

## Counting honestly

Entries are prose, not quantities. `"three Bellinis and an espresso martini"`
is four drinks in one row, and `"two more espresso martinis (3 total today)"`
is telling you the running total, not adding three.

- Read the numbers inside each body; don't count rows.
- When entries overlap or restate a total, prefer his explicit total.
- Say what you counted, not just the number — "9, mostly the martinis on the
  15th and 19th" lets him correct you. A bare total doesn't.
- If the entries are genuinely ambiguous, give your best count and say which
  ones you were unsure about. Never round an uncertainty into a clean number.

## Worked example

> **him:** how many drinks have I had this month

1. Counting question → window for the month, **no** `query`.
2. Read every entry, pick the alcohol ones, add up the amounts *in the text*.
3. Answer with the count and name the occasions.

The failure to avoid, verbatim from 2026-08-22:

> **her:** Nothing logged for drinks this month yet.

Four entries and nine drinks were in the table. The search was
`ilike '%drinks%'`, it matched nothing, and the nothing was reported as fact.
