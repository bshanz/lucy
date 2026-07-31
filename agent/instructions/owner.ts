import { defineDynamic, defineInstructions } from "eve/instructions";

/**
 * Injects owner-specific details into the prompt at RUNTIME (session start),
 * where process.env is available. The base persona in ../instructions.ts is
 * fully generic; this is the only place personal context enters the prompt,
 * and it comes from env — never from source.
 */
export default defineDynamic({
  events: {
    "session.started": () => {
      const agent = process.env.AGENT_NAME || "Lucy";
      const owner = process.env.OWNER_NAME || "the owner";
      const first = owner.split(" ")[0];
      const email = process.env.OWNER_EMAIL || "(not configured)";
      const tz = process.env.OWNER_TIMEZONE || "America/New_York";
      return defineInstructions({
        markdown: `## Owner details

- Your name is **${agent}**.
- Your owner is **${owner}** — address them as ${first}.
- Their email: ${email}. Their timezone: ${tz} — all wall-clock times you pass to tools are in this zone.`,
      });
    },
  },
});
