import { defineEvalConfig } from "eve/evals";

/**
 * Shared eval defaults.
 *
 * The judge model is the same one the agent runs on, for one boring reason:
 * it's the only model id this project already proves works through the AI
 * Gateway. Judge assertions are soft here, so a judge outage degrades an eval
 * to "scored", never to a false failure.
 *
 * Timeout is generous because these evals drive a real agent against real
 * Supabase and a real model — a turn that takes 20s is normal, not a hang.
 */
export default defineEvalConfig({
  judge: { model: "anthropic/claude-sonnet-5" },
  timeoutMs: 120_000,
});
