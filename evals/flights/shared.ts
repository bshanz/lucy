import { accountQuota } from "#lib/flights.js";

/**
 * What a flights eval run costs, recorded into the artifact.
 *
 * The diary evals clean up after themselves because a stray moment row is a
 * wrong answer to a question he asks later. Flights can't do that: a SerpAPI
 * search is genuinely spent the moment it resolves, and there is no refund.
 *
 * The tempting move — decrement the `flights:searches:<date>` counter that
 * `search_flights` keeps in `channel_state` — is actively wrong. That counter
 * is the soft daily budget protecting the 250/month allowance (see
 * MAX_INTERACTIVE_PER_DAY). Rolling it back after really spending a search
 * doesn't undo the cost, it just blinds the budget to it, which is the one
 * direction that can turn a green eval into a month with no searches left.
 *
 * So: report, don't repair. `accountQuota()` hits SerpAPI's /account endpoint,
 * which is free and not itself counted, so the honest number is cheap to get.
 */
export async function reportFlightSpend(): Promise<string> {
  try {
    const quota = await accountQuota();
    return (
      `SerpAPI quota after this eval: ${quota.totalSearchesLeft} searches left ` +
      `(${quota.thisMonthUsage} used this cycle, renews ${quota.planRenewalDate})`
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return `SerpAPI quota check failed: ${detail.slice(0, 200)}`;
  }
}
