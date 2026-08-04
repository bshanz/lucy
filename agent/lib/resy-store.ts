import { setTokenStore, type ResyTokens } from "#lib/resy.js";
import { supabase } from "#lib/supabase.js";

/**
 * Persistence for Resy tokens, kept OUT of #lib/resy.js on purpose.
 *
 * resy.ts holds the protocol and the pure ranking logic and imports neither
 * Supabase nor env-dependent state, which is what makes rankSlots/computeDropAt
 * testable without a database. This module is the seam where the two meet.
 *
 * Importing it installs the store. Every tool and schedule that touches Resy
 * imports this instead of resy.js directly — forget it and getAuthToken() will
 * quietly re-login from the password on every cold start, burning a login per
 * invocation and eventually tripping Resy's own abuse heuristics.
 */

const ROW_ID = true; // the singleton primary key; see supabase/migrations/0005_resy.sql

/**
 * Read the stored session, or null if Resy was never connected.
 *
 * Exported because resy-auth needs to answer two questions this store otherwise
 * hides: "is Resy connected at all?" (so it doesn't nag about a feature the
 * owner never set up) and "how long has the refresh window got left?" (so it can
 * warn while there's still time to act).
 */
export async function loadResyTokens(): Promise<ResyTokens | null> {
  const { data, error } = await supabase
    .from("resy_credentials")
    .select("auth_token, refresh_token, auth_expires_at, refresh_expires_at")
    .eq("id", ROW_ID)
    .maybeSingle();

  // A read failure must not masquerade as "no credentials" — that would send
  // getAuthToken() down the re-login path on every transient Supabase blip, and
  // on an OTP-only account that means texting the owner for no reason.
  if (error) throw new Error(`Couldn't read Resy credentials: ${error.message}`);
  if (!data?.auth_token) return null;

  return {
    authToken: data.auth_token as string,
    refreshToken: (data.refresh_token as string | null) ?? null,
    authExpiresAt: data.auth_expires_at ? Date.parse(data.auth_expires_at as string) : null,
    refreshExpiresAt: data.refresh_expires_at
      ? Date.parse(data.refresh_expires_at as string)
      : null,
  };
}

setTokenStore({
  load: loadResyTokens,

  async save(t: ResyTokens): Promise<void> {
    const { error } = await supabase.from("resy_credentials").upsert(
      {
        id: ROW_ID,
        auth_token: t.authToken,
        refresh_token: t.refreshToken,
        auth_expires_at: t.authExpiresAt ? new Date(t.authExpiresAt).toISOString() : null,
        refresh_expires_at: t.refreshExpiresAt
          ? new Date(t.refreshExpiresAt).toISOString()
          : null,
        last_refreshed_at: new Date().toISOString(),
      },
      { onConflict: "id" },
    );
    if (error) throw new Error(`Couldn't save Resy credentials: ${error.message}`);
  },
});

/**
 * No-op that exists so `import "#lib/resy-store.js"` isn't mistaken for an
 * unused import and stripped by a future tidy-up. Call it once in tools that
 * need auth; the side effect above is the actual point.
 */
export function ensureResyStore(): void {}
