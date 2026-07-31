import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Service-role Supabase client for Lucy (project "lucy").
 *
 * Uses the secret key and therefore bypasses RLS. Lucy is single-tenant —
 * every row belongs to the owner — but tools must still never trust identifiers
 * supplied by the model over the session's verified auth context.
 *
 * Constructed lazily: eve imports tool modules during discovery (`eve info`,
 * build) without secrets present, so we must not touch env at module load.
 */
let client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (client) return client;

  const url = process.env.SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY;

  if (!url) throw new Error("SUPABASE_URL is not set");
  if (!secret) throw new Error("SUPABASE_SECRET_KEY is not set");

  client = createClient(url, secret, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return client;
}

/** Lazy proxy: behaves like a SupabaseClient but defers construction to first use. */
export const supabase: SupabaseClient = new Proxy({} as SupabaseClient, {
  get(_target, prop, receiver) {
    const real = getClient();
    const value = Reflect.get(real as object, prop, receiver);
    return typeof value === "function" ? value.bind(real) : value;
  },
});
