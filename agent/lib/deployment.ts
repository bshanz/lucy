import { supabase } from "#lib/supabase.js";

/**
 * Which deployment a piece of this agent is running on, and which one a live
 * session is stuck to.
 *
 * Worth knowing because of an asymmetry that caused a silent outage on
 * 2026-08-22. A durable eve session PINS to the deployment that created it, and
 * its channel event handlers keep running there indefinitely — while schedules
 * and model turns run on current production. So a session can be thinking with
 * today's instructions and tools while SPEAKING through code from weeks ago.
 *
 * That is precisely what broke. The owner's session was pinned to a build made
 * before the sendblue channel had an `input.requested` handler at all. When eve
 * paused the session on its per-session input-token limit and raised the
 * Approve/Stop continuation prompt, the request went to a channel with no code
 * to render it. He was never asked, every later text queued behind an approval
 * he couldn't see, and nothing logged an error. The handler had been deployed
 * for three weeks and could not reach the running session.
 *
 * Deploying does not fix a session. Only rotating it does — which is why this
 * feeds the rotation rule in the sendblue channel rather than an alert. An
 * alert would fire after every single deploy (drift is permanent until
 * rotation) and would teach the owner to ignore it.
 */

/** The deployment serving this code, or null off-Vercel (local dev, evals). */
export function currentDeploymentId(): string | null {
  return process.env.VERCEL_DEPLOYMENT_ID || process.env.VERCEL_URL || null;
}

export interface PinnedDeployment {
  deploymentId: string;
  sha?: string;
  seenAt: string;
}

const pinnedKey = (phone: string) => `session:pinned_deploy:${phone}`;

/**
 * Record the deployment a session's channel handlers are actually running on.
 *
 * MUST be called from a channel EVENT handler. That is the whole trick: events
 * fire inside the durable run, so they report the pinned deployment, whereas
 * anything called from a schedule or route reports current production and would
 * make drift permanently invisible.
 */
export async function recordPinnedDeployment(phone: string): Promise<void> {
  const deploymentId = currentDeploymentId();
  if (!deploymentId) return;
  await supabase.from("channel_state").upsert(
    [
      {
        key: pinnedKey(phone),
        value: {
          deploymentId,
          sha: process.env.VERCEL_GIT_COMMIT_SHA,
          seenAt: new Date().toISOString(),
        } satisfies PinnedDeployment,
        updated_at: new Date().toISOString(),
      },
    ],
    { onConflict: "key" },
  );
}

/** The deployment this session's handlers last ran on, or null if never seen. */
export async function readPinnedDeployment(phone: string): Promise<PinnedDeployment | null> {
  const { data } = await supabase
    .from("channel_state")
    .select("value")
    .eq("key", pinnedKey(phone))
    .maybeSingle();
  const value = data?.value as PinnedDeployment | null;
  return value?.deploymentId ? value : null;
}

/**
 * True when this session's handlers are running older code than production.
 *
 * Never throws and answers `false` when it cannot tell — off-Vercel, no turn
 * recorded yet, or the state store unreachable. A false negative costs a
 * slower rotation; a false positive would throw away a live conversation.
 */
export async function isRunningStaleCode(phone: string): Promise<boolean> {
  try {
    const current = currentDeploymentId();
    if (!current) return false;
    const pinned = await readPinnedDeployment(phone);
    if (!pinned) return false;
    return pinned.deploymentId !== current;
  } catch {
    return false;
  }
}
