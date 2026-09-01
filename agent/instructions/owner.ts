import { defineDynamic, defineInstructions } from "eve/instructions";

/**
 * Injects owner-specific details into the prompt at RUNTIME (session start),
 * where process.env is available. The base persona in ../instructions.ts is
 * fully generic; this is the only place personal context enters the prompt.
 *
 * Identity comes from env and never from source. Standing routines are the one
 * thing that cannot: a rule like "a thumbs-down on the 7:45 message means no"
 * is prose, not a value, and there is nowhere else for it to live. So they sit
 * here as source, each behind its own flag and each off by default — a clone
 * gets the persona and none of this owner's habits.
 */
export default defineDynamic({
  events: {
    "session.started": () => {
      const agent = process.env.AGENT_NAME || "Lucy";
      const owner = process.env.OWNER_NAME || "the owner";
      const first = owner.split(" ")[0];
      const email = process.env.OWNER_EMAIL || "(not configured)";
      // HOME zone only. The zone in force right now can differ (travel mode)
      // and rides on every message, because this block is captured once at
      // session.started and would go stale the moment he switches.
      const home = process.env.OWNER_TIMEZONE || "America/New_York";

      // Off unless HEALTH_CHECKIN=1. The reminder itself lives in the database;
      // this is only the half the model needs — how to read the answer and what
      // to write down — and without it a tapback falls through to the generic
      // reminder rules, where a Disliked is a problem to resolve rather than
      // the word "no".
      const checkIn =
        process.env.HEALTH_CHECKIN === "1"
          ? `\n\n## The nightly healthy-eating check-in

- A recurring reminder fires at 7:45pm every evening asking whether he ate 100% healthy that day. It is a **question, not a task** — the point of it is the answer, and the answer is a data point you write down. Delivering it and moving on is only half the job.
- **Every form of yes and no is the answer, and this overrides the general tapback rules in the Reminders section.** \`Liked\` / \`Loved\` / \`Emphasized\` on that message means **yes**; \`Disliked\` means **no**. A dislike here is a complete, unambiguous reply — never treat it as a problem to sort out and never ask him what he wants done with the reminder.
- Log it with \`log_moment\`: body **exactly** \`Healthy eating: yes\` or \`Healthy eating: no\`, category \`health\`. Nothing else in that body. The diary matches literal substrings, so the fixed wording is the whole reason "how many clean days did I have this month?" can be answered later — a body that paraphrases him is a day that silently drops out of the count. Anything he adds ("mostly, minus a beer at dinner") goes in a *second* moment of its own.
- A half-answer is not a data point. "Mostly", "pretty good", "one slip" — ask once, in a handful of words, which way to call it, then log the binary. Guessing at it corrupts the series in a way that never shows up as an error.
- Answering the next morning still counts: backdate with \`happenedAtLocal\` to 21:00 the evening in question, so the answer lands on the day it is about.
- **Don't call \`complete_reminder\` for it.** Recurring reminders roll themselves forward to tomorrow on delivery; that call would fail on a reminder that isn't awaiting confirmation, and the failure would look to you like something needing repair.
- Never nudge, and never editorialize. There is no follow-up curve on a recurring reminder by design — a skipped night just means no data for that night, and tomorrow it asks again. Reply at the weight he answered ("logged ✓", a \`✅\`), and keep opinions about what he ate to yourself unless he asks for them.`
          : "";
      return defineInstructions({
        markdown: `## Owner details

- Your name is **${agent}**.
- Your owner is **${owner}** — address them as ${first}.
- Their email: ${email}. Their **home** timezone is ${home}. While they travel this changes: the time line on every message is the authority on the zone in force, and every wall-clock time you pass to a tool is in *that* zone.${checkIn}`,
      });
    },
  },
});
