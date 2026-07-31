import { eveChannel } from "eve/channels/eve";
import { localDev, placeholderAuth, vercelOidc } from "eve/channels/auth";

/**
 * Route auth for Lucy's default HTTP API (dev UI, /eve/v1/session).
 *
 * Lucy's real surfaces are the sendblue and slack channels, which do their
 * own sender verification. This channel only needs to work for local dev and
 * internal Vercel callers; placeholderAuth keeps production browser traffic
 * behind a clear 401.
 *
 * LUCY_AGENT_SECRET gates the sendblue webhook + gmail authorize routes. If
 * it's missing in production those routes would be unreachable (or worse,
 * misconfigured), so refuse to boot rather than fail silently.
 */
if (process.env.VERCEL_ENV === "production" && !process.env.LUCY_AGENT_SECRET) {
  throw new Error(
    "LUCY_AGENT_SECRET must be set in production — it gates Lucy's webhook and authorize routes.",
  );
}

export default eveChannel({
  auth: [localDev(), vercelOidc(), placeholderAuth()],
});
