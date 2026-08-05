import { ownerWallClockToUtc } from "#lib/reminders.js";

/**
 * Resy client + the pure logic behind reservation sniping.
 *
 * Resy has no public API. This talks to the same undocumented JSON API the
 * resy.com web app uses, on the owner's own account, for the owner's own
 * reservations. Two consequences worth internalising before editing anything:
 *
 *  1. IT CAN CHANGE WITHOUT NOTICE. Every response shape below is defensive —
 *     missing fields degrade to "no availability", never to a thrown 500 in a
 *     cron. A snipe that crashes is indistinguishable to the owner from a
 *     snipe that lost, except it's our fault.
 *  2. THE API KEY ROTATES. Every Resy bot on GitHub hardcodes
 *     `VbWk7s3L4KiK5fzlO7JD3Q5EYolJI4G1`; that key is dead and returns a bare
 *     `419 Unauthorized`. The live key is scraped from the web bundle at
 *     runtime (see resyApiKey). Pinning it is the single most common way these
 *     integrations rot. Do not "simplify" it back to a constant.
 *
 * ⚠️ CREDENTIAL DISCIPLINE. Tool return values are read by the model and can be
 * texted to the owner. The auth token IS the account — with it you can book,
 * cancel, and read the owner's payment methods. So: no token, refresh token,
 * password, or payment_method_id may EVER appear in a return value, a thrown
 * message, or a console line. Every error here is built through redact(). This
 * is the same rule #lib/flights.js applies to the SerpAPI key, for the same
 * reason, and it is easier to break here because the credential is a header
 * rather than something visibly embedded in a URL.
 *
 * Env is read lazily — eve imports modules during discovery (`eve info`,
 * build) in an env-less sandbox, so touching process.env at module load breaks
 * the build.
 */

const RESY_API = "https://api.resy.com";
const RESY_WEB = "https://resy.com";
const REQUEST_TIMEOUT_MS = 10_000;
/**
 * Race timeouts, split because the two kinds of call want opposite things.
 *
 * /4/find is polled in a loop, so a short leash is right: a slow response is
 * cheap to abandon and retry 250ms later.
 *
 * ⚠️ /3/details and /3/book are ONE-SHOT and must NOT share that leash. They are
 * the heaviest endpoints (details returns venue+payment+user in one payload) and
 * they are hammered by everyone at the exact second of a drop, so they are
 * slowest precisely when they matter. On 2026-08-05 a 3s cap on /3/book aborted
 * the client while Resy went on to commit the booking — the table was won, the
 * owner was charged, and the snipe reported a clean miss. Give writes room.
 */
const RACE_FIND_TIMEOUT_MS = 3_000;
const RACE_WRITE_TIMEOUT_MS = 12_000;

/**
 * Chrome UA.
 *
 * api.resy.com sits behind Imperva (`x-cdn: Imperva`, `x-iinfo` on responses) —
 * an earlier note here claimed "plain nginx, no bot manager", which was wrong:
 * that check grepped for Akamai and Cloudflare headers and Imperva uses neither.
 * In practice it has never challenged us — plain fetch gets 200s on search,
 * auth, availability and booking alike — so no browser or stealth layer is
 * warranted. But it is a WAF, so keep the request shape boring: browser-like UA,
 * real Origin/Referer, no bursts. The bounded retry cap in the drop race is part
 * of that, not just courtesy.
 */
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

/**
 * Renew this far ahead of expiry. Wide enough to survive a cron outage.
 *
 * ⚠️ OTP login does NOT return a refresh token — the response carries `token`
 * and `legacy_token` and nothing else. (The 45-day/90-day pair documented by the
 * community Go clients comes from the PASSWORD flow, which this account can't
 * use: `has_set_password` is 0.) So for a code-linked session there is nothing
 * to refresh, and the margin below only governs how early we start warning.
 * refreshTokens() is still correct for password-linked accounts; it simply never
 * runs on this one.
 */
export const AUTH_REFRESH_MARGIN_MS = 5 * 24 * 3600 * 1000;
/** Slots are ranked, but we never try more than this many before conceding. */
export const MAX_BOOK_ATTEMPTS = 4;
/** Hard cap on the drop-race polling loop. Bounded because hammering gets accounts flagged. */
export const MAX_FIND_POLLS = 40;
export const FIND_POLL_INTERVAL_MS = 250;
/** Start looking slightly before the published drop — clocks disagree. */
export const RACE_LEAD_MS = 400;
/** Keep the pre-warm cheap but early enough that nothing slow happens at T-0. */
export const PREWARM_LEAD_MS = 10_000;
/** More than this and a lost race is a fleet of crons, not a personal assistant. */
export const MAX_ACTIVE_SNIPES = 8;

export type ResyErrorKind =
  | "auth" // token rejected/expired — credentials need attention
  | "needs_login" // no usable session and no unattended way to get one; owner must text a code
  | "not_configured" // Resy was never connected at all
  | "gone" // slot vanished mid-book (the normal way a race is lost)
  | "payment_required" // deposit needed
  | "recaptcha" // venue gates booking behind reCAPTCHA
  | "rate_limited"
  | "bad_request"
  | "transport";

export class ResyError extends Error {
  readonly kind: ResyErrorKind;
  readonly status: number | null;
  constructor(message: string, kind: ResyErrorKind, status: number | null = null) {
    super(message);
    this.name = "ResyError";
    this.kind = kind;
    this.status = status;
  }
}

/**
 * Last line of defence before a string reaches a log, a thrown message, or a
 * tool return. Resy echoes submitted values back in some error bodies, so an
 * upstream message can contain the token we just sent it.
 *
 * Deliberately operates on VALUES rather than known key names: the goal is to
 * survive a response shape nobody anticipated.
 */
export function redact(text: string): string {
  let out = text;
  for (const secret of [
    process.env.RESY_PASSWORD,
    process.env.RESY_EMAIL,
    cachedAuth?.authToken,
    cachedAuth?.refreshToken,
  ]) {
    if (secret && secret.length >= 6) out = out.split(secret).join("[redacted]");
  }
  // JWT-shaped material, whatever key it arrived under.
  out = out.replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted]");
  return out;
}

// ---------------------------------------------------------------------------
// API key
// ---------------------------------------------------------------------------

let cachedKey: { key: string; at: number } | null = null;
const KEY_TTL_MS = 6 * 3600 * 1000;

/**
 * Scrape the public API key out of resy.com's JS bundle.
 *
 * The key is not a secret — it ships to every browser and identifies the web
 * client, not the user. It does rotate, which is the whole point of doing this
 * at runtime. Flow: homepage HTML → `modules/app.<hash>.js` → `apiKey:"…"`.
 *
 * Cached for 6h; a snipe pre-warms this well before T-0 so the drop race never
 * pays for two extra round trips.
 */
export async function resyApiKey(): Promise<string> {
  if (cachedKey && Date.now() - cachedKey.at < KEY_TTL_MS) return cachedKey.key;

  const fallback = process.env.RESY_API_KEY_FALLBACK;
  try {
    const html = await fetchText(RESY_WEB + "/");
    const bundle = html.match(/src="(modules\/app\.[a-f0-9]+\.js)"/)?.[1];
    if (!bundle) throw new Error("no app bundle in homepage");

    const js = await fetchText(`${RESY_WEB}/${bundle}`);
    const key = js.match(/apiKey:\s*"([A-Za-z0-9]{20,})"/)?.[1];
    if (!key) throw new Error("no apiKey in bundle");

    cachedKey = { key, at: Date.now() };
    return key;
  } catch (err) {
    // A stale key still beats no key: it may not have rotated yet, and the
    // caller gets a clean 419 rather than a crash if it has.
    if (fallback) {
      console.warn("[resy] api key scrape failed, using RESY_API_KEY_FALLBACK:", redact(String(err)));
      cachedKey = { key: fallback, at: Date.now() };
      return fallback;
    }
    throw new ResyError(
      `Couldn't read Resy's API key from their site (${redact(String(err))}). ` +
        `Set RESY_API_KEY_FALLBACK if this persists.`,
      "transport",
    );
  }
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "user-agent": UA, accept: "*/*" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${res.status} fetching ${url}`);
  return res.text();
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export type ResyTokens = {
  authToken: string;
  refreshToken: string | null;
  /** ms epoch, decoded from the JWT when present. */
  authExpiresAt: number | null;
  refreshExpiresAt: number | null;
};

/** Process-local cache so a burst of calls in one invocation hits the DB once. */
let cachedAuth: ResyTokens | null = null;

/** Injected by the persistence layer (schedules/tools own Supabase, this file doesn't). */
export type TokenStore = {
  load: () => Promise<ResyTokens | null>;
  save: (t: ResyTokens) => Promise<void>;
};
let store: TokenStore | null = null;
export function setTokenStore(s: TokenStore): void {
  store = s;
}

/** `exp` out of a JWT payload, in ms. Returns null for opaque tokens. */
export function jwtExpiry(token: string): number | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof json.exp === "number" ? json.exp * 1000 : null;
  } catch {
    return null;
  }
}

function tokensFrom(body: Record<string, unknown>): ResyTokens {
  const authToken = String(body.token ?? body.auth_token ?? "");
  if (!authToken) throw new ResyError("Resy login returned no token", "auth");
  const refreshToken =
    typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : null;
  return {
    authToken,
    refreshToken,
    authExpiresAt: jwtExpiry(authToken),
    refreshExpiresAt: refreshToken ? jwtExpiry(refreshToken) : null,
  };
}

/**
 * Endpoint paths, read out of resy.com's own JS bundle rather than guessed.
 *
 * ⚠️ The versions are genuinely inconsistent and it is not a typo: auth lives on
 * /4 except refresh and the email-code request, which are still on /3. Every
 * Resy bot on GitHub calls /3/auth/password, which no longer exists. Verify
 * against the bundle before changing any of these:
 *   grep -oF '4/auth/password' modules/app.<hash>.js
 */
const AUTH_PASSWORD = "/4/auth/password";
const AUTH_MOBILE = "/4/auth/mobile"; // request an SMS code
const AUTH_CHALLENGE = "/4/auth/challenge"; // exchange the code for a token
const AUTH_REFRESH = "/3/auth/refresh";

/**
 * `device_type_id` in Resy's payloads, sourced from a `WEB` constant in the web
 * app. Overridable because the constant is minified beyond easy extraction and
 * this is the one auth parameter here that isn't verbatim from the bundle. If
 * the OTP exchange starts rejecting valid codes, this is the first thing to try.
 */
function deviceTypeId(): string {
  return process.env.RESY_DEVICE_TYPE_ID ?? "3";
}

/** Stable per-install id. Resy ties a code to the device that asked for it. */
function deviceToken(): string {
  return process.env.RESY_DEVICE_TOKEN ?? "lucy-agent";
}

/**
 * Ask Resy to text a login code to the owner's phone.
 *
 * This is step one of the OTP flow, which is how most Resy accounts actually
 * sign in. It has a real-world side effect — the owner's phone buzzes — so it is
 * only ever called from an explicitly owner-initiated tool, never from a cron.
 *
 * `method: "sms"` matches what the web app sends. A `captcha_token` is
 * conditionally attached by the web client, so Resy CAN demand a captcha here;
 * if that starts happening the error surfaces as kind "recaptcha" and the
 * fallback is a one-time login through the agent-browser sandbox.
 */
export async function requestLoginCode(mobileNumber: string): Promise<void> {
  await resyFetch(AUTH_MOBILE, {
    method: "POST",
    form: {
      mobile_number: mobileNumber,
      method: "sms",
      device_type_id: deviceTypeId(),
      device_token: deviceToken(),
    },
    authenticated: false,
  });
}

/**
 * Trade the texted code for a session. THIS IS A THREE-STEP FLOW, not two.
 *
 * Verified against the live API, because the obvious reading is wrong twice:
 *
 *  1. The code is verified by POSTing back to /4/auth/mobile — the SAME endpoint
 *     that sent it. Sending `code` is what distinguishes verify from request.
 *     Posting the code to /4/auth/challenge instead returns
 *     `{"challenge_id": "An invalid challenge_id was provided"}`, which reads
 *     like a bad code and is really a bad endpoint.
 *
 *  2. Resy then answers with a `challenge` — "Hey Brian, is that you?" — and
 *     asks for a SECOND FACTOR, the email address on the account. Only after
 *     /4/auth/challenge succeeds does a token come back. A two-step
 *     implementation gets a 200 at step 2 and no token, and looks like a
 *     rejected code.
 *
 * The email comes from OWNER_EMAIL, never from the model, for the same reason
 * the phone number does: together they are the whole credential.
 */
export async function verifyLoginCode(
  mobileNumber: string,
  code: string,
): Promise<ResyTokens> {
  const first = await resyFetch<Record<string, any>>(AUTH_MOBILE, {
    method: "POST",
    form: {
      code,
      mobile_number: mobileNumber,
      device_type_id: deviceTypeId(),
      device_token: deviceToken(),
    },
    authenticated: false,
  });

  // Some accounts may hand back a token immediately with no second factor.
  if (first?.token || first?.user?.token) {
    const tokens = tokensFrom(first.user ?? first);
    await persist(tokens);
    return tokens;
  }

  const challenge = first?.challenge;
  if (!challenge?.challenge_id) {
    throw new ResyError(
      "Resy accepted the code but didn't return a session. The code may have already been used.",
      "auth",
    );
  }

  // The challenge declares what it wants. Today that is always the account
  // email; anything else needs a human, so say so rather than guessing.
  const wants: string[] = (challenge.properties ?? []).map((p: any) => p?.name);
  if (wants.length > 0 && !wants.includes("em_address")) {
    throw new ResyError(
      `Resy is asking for something I can't supply (${wants.join(", ")}). ` +
        `The owner will need to sign in on resy.com this time.`,
      "needs_login",
    );
  }

  const email = process.env.OWNER_EMAIL;
  if (!email) {
    throw new ResyError(
      "Resy wants the account's email address to finish signing in, but OWNER_EMAIL isn't set.",
      "not_configured",
    );
  }

  const user = await resyFetch<Record<string, unknown>>(AUTH_CHALLENGE, {
    method: "POST",
    form: {
      challenge_id: String(challenge.challenge_id),
      em_address: email,
      device_type_id: deviceTypeId(),
      device_token: deviceToken(),
    },
    authenticated: false,
  });

  const tokens = tokensFrom(user);
  await persist(tokens);
  return tokens;
}

/**
 * Password login. Optional — many Resy accounts are OTP-only and never set one.
 *
 * Kept because when a password DOES exist it is the only fully unattended way to
 * recover a dead session. Without it, a session that outlives its refresh token
 * needs the owner to text a code back.
 */
export async function login(): Promise<ResyTokens> {
  const email = process.env.RESY_EMAIL;
  const password = process.env.RESY_PASSWORD;
  if (!email || !password) {
    throw new ResyError(
      "Resy needs re-authorising and there's no password on file to do it automatically — " +
        "the owner has to request a login code and text it back.",
      "needs_login",
    );
  }

  const body = await resyFetch<Record<string, unknown>>(AUTH_PASSWORD, {
    method: "POST",
    form: { email, password },
    authenticated: false,
  });
  const tokens = tokensFrom(body);
  await persist(tokens);
  return tokens;
}

/** Trade the 90-day refresh token for a fresh 45-day pair. */
export async function refreshTokens(refreshToken: string): Promise<ResyTokens> {
  const body = await resyFetch<Record<string, unknown>>(AUTH_REFRESH, {
    method: "POST",
    form: { refresh_token: refreshToken },
    authenticated: false,
  });
  const tokens = tokensFrom(body);
  await persist(tokens);
  return tokens;
}

async function persist(tokens: ResyTokens): Promise<void> {
  cachedAuth = tokens;
  if (store) await store.save(tokens);
}

/**
 * When the session actually dies, in ms epoch, or null if it can't be known.
 *
 * The governing clock is NOT always the same field. A password-linked account
 * has a refresh token, so the session survives until THAT expires. A code-linked
 * account has none — the auth token's own expiry is the end of the line.
 *
 * Getting this wrong is silent and total: reading refresh_expires_at on an
 * OTP-only account yields null, every "is it expiring?" check short-circuits to
 * "no", and the owner discovers his session died when a snipe doesn't fire.
 */
export function sessionExpiresAt(t: ResyTokens): number | null {
  return t.refreshToken ? t.refreshExpiresAt : t.authExpiresAt;
}

export function tokensNeedRefresh(t: ResyTokens, marginMs = AUTH_REFRESH_MARGIN_MS): boolean {
  if (!t.authExpiresAt) return false; // opaque token — can't reason, don't churn
  return Date.now() > t.authExpiresAt - marginMs;
}

/**
 * The accessor every authenticated call goes through.
 *
 * Self-healing by design: refreshes lazily when inside the expiry margin, and
 * falls all the way back to a password login if the refresh token is dead too.
 * The daily resy-auth cron is belt-and-braces on top of this — a missed cron
 * must never be what strands a snipe at T-0.
 *
 * `force` re-checks even when a process-local token looks fine; the snipe
 * pre-warm uses it so refresh latency is paid before the clock starts.
 */
export async function getAuthToken(force = false): Promise<string> {
  if (!cachedAuth && store) cachedAuth = await store.load();

  if (cachedAuth && !force && !tokensNeedRefresh(cachedAuth)) return cachedAuth.authToken;

  if (cachedAuth?.refreshToken) {
    const refreshOk =
      !cachedAuth.refreshExpiresAt || cachedAuth.refreshExpiresAt > Date.now() + 60_000;
    if (refreshOk && (force || tokensNeedRefresh(cachedAuth))) {
      try {
        return (await refreshTokens(cachedAuth.refreshToken)).authToken;
      } catch (err) {
        console.warn("[resy] refresh failed, falling back to password login:", redact(String(err)));
      }
    } else if (refreshOk) {
      return cachedAuth.authToken;
    }
  }

  if (cachedAuth && !tokensNeedRefresh(cachedAuth)) return cachedAuth.authToken;

  // Nothing usable is left. Password login is the ONLY unattended way back, and
  // most Resy accounts are OTP-only and have no password at all — so distinguish
  // "never connected" from "session died", because they need different things
  // from the owner and a generic error would send him hunting for the wrong one.
  if (!cachedAuth && !process.env.RESY_PASSWORD) {
    throw new ResyError(
      "Resy isn't connected yet — the owner needs to link his account with a login code.",
      "not_configured",
    );
  }
  return (await login()).authToken;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

type FetchOpts = {
  method?: "GET" | "POST";
  query?: Record<string, string | number>;
  /** Resy's write endpoints are form-encoded, not JSON. Booking fails silently otherwise. */
  form?: Record<string, string | number>;
  json?: unknown;
  authenticated?: boolean;
  timeoutMs?: number;
};

async function resyFetch<T>(path: string, opts: FetchOpts = {}): Promise<T> {
  const { method = "GET", query, form, json, authenticated = true, timeoutMs } = opts;

  const url = new URL(RESY_API + path);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, String(v));

  const headers: Record<string, string> = {
    authorization: `ResyAPI api_key="${await resyApiKey()}"`,
    "user-agent": UA,
    origin: RESY_WEB,
    referer: RESY_WEB + "/",
    accept: "application/json, text/plain, */*",
    "cache-control": "no-cache",
  };
  if (authenticated) {
    const token = await getAuthToken();
    headers["x-resy-auth-token"] = token;
    headers["x-resy-universal-auth"] = token;
  }

  let body: string | undefined;
  if (form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(
      Object.entries(form).map(([k, v]) => [k, String(v)] as [string, string]),
    ).toString();
  } else if (json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(json);
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new ResyError(`Couldn't reach Resy (${redact(String(err))})`, "transport");
  }

  const text = await res.text();

  if (!res.ok) throw errorFor(res.status, text);
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ResyError(`Resy returned a non-JSON response (${res.status})`, "transport", res.status);
  }
}

/**
 * Status → kind. The ones that matter during a drop race:
 *   404 the slot went to somebody else (normal; try the next-best slot)
 *   412 Resy's own "that time is gone" — same meaning, different number
 *   402 a deposit is required (compare against the owner's pre-authorized cap)
 *   419 the API key rotated out from under us
 */
function errorFor(status: number, body: string): ResyError {
  const safe = redact(body).slice(0, 300);
  let message = safe;
  try {
    const parsed = JSON.parse(body) as { message?: string };
    if (parsed.message) message = redact(parsed.message);
  } catch {
    /* keep the truncated body */
  }

  if (status === 419 || status === 401) {
    cachedKey = null; // force a re-scrape; the usual cause is key rotation
    return new ResyError(`Resy rejected our credentials (${status}): ${message}`, "auth", status);
  }
  if (status === 402) return new ResyError(`Resy requires a deposit: ${message}`, "payment_required", status);
  if (status === 404 || status === 412) return new ResyError(`That table is gone: ${message}`, "gone", status);
  if (status === 429) return new ResyError("Resy is rate-limiting us", "rate_limited", status);
  if (status >= 500) return new ResyError(`Resy is having problems (${status})`, "transport", status);
  if (/recaptcha/i.test(body)) return new ResyError("This venue requires a reCAPTCHA to book", "recaptcha", status);
  return new ResyError(`Resy rejected the request (${status}): ${message}`, "bad_request", status);
}

// ---------------------------------------------------------------------------
// Venues
// ---------------------------------------------------------------------------

export type ResyVenue = {
  id: number;
  name: string;
  slug: string | null;
  city: string | null;
  neighborhood: string | null;
  cuisine: string | null;
  maxPartySize: number | null;
  /**
   * PER-VENUE, and the reason a snipe can be dead on arrival. Carbone NYC is
   * false; Carbone Miami is true. A reCAPTCHA venue cannot be booked headlessly,
   * so snipe_resy refuses to arm one rather than failing at T-0 on an evening
   * the owner has already planned around.
   */
  requiresRecaptcha: boolean;
  /** Listed on Resy but held in Tock's inventory — not bookable through this API. */
  isTockInventory: boolean;
};

function parseVenue(hit: Record<string, any>): ResyVenue {
  return {
    id: Number(hit?.id?.resy ?? hit?.id ?? 0),
    name: String(hit?.name ?? "Unknown"),
    slug: hit?.url_slug ?? null,
    city: hit?.locality ?? hit?.location?.name ?? null,
    neighborhood: hit?.neighborhood ?? null,
    cuisine: Array.isArray(hit?.cuisine) ? hit.cuisine.join(", ") : hit?.cuisine ?? null,
    maxPartySize: typeof hit?.max_party_size === "number" ? hit.max_party_size : null,
    requiresRecaptcha: hit?.feature_recaptcha === true,
    isTockInventory: hit?.is_tock_inventory === true,
  };
}

/**
 * Venue search. Unauthenticated — verified working with only the scraped key,
 * which is what lets Lucy resolve "Carbone" → 6194 without ever asking the
 * owner for an id.
 */
export async function venueSearch(query: string, limit = 5): Promise<ResyVenue[]> {
  const body = await resyFetch<{ search?: { hits?: Record<string, any>[] } }>(
    "/3/venuesearch/search",
    { method: "POST", json: { query, per_page: limit }, authenticated: false },
  );
  return (body.search?.hits ?? []).slice(0, limit).map(parseVenue).filter((v) => v.id > 0);
}

/**
 * Re-resolve a venue by id, using the name as the search handle.
 *
 * Deliberately built on /3/venuesearch/search rather than /3/venue: search is
 * the endpoint verified to work unauthenticated, and it is the one that carries
 * the flags the arm-time guard depends on (feature_recaptcha, max_party_size,
 * is_tock_inventory). Resolving through a second, unverified endpoint to save a
 * round trip would trade a known-good path for an assumption.
 *
 * Returns null when the id isn't among the matches, which is the signal to go
 * back through search_resy rather than to arm something unverified.
 */
export async function venueLookup(venueId: number, nameHint: string): Promise<ResyVenue | null> {
  const hits = await venueSearch(nameHint, 10);
  return hits.find((v) => v.id === venueId) ?? null;
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

export type ResySlot = {
  /** Opaque config token — the handle passed to /3/details. Not secret. */
  configToken: string;
  /** Venue-LOCAL wall clock, "HH:MM". No timezone math anywhere in this file. */
  time: string;
  /** "Dining Room", "Bar", "Patio", … */
  type: string | null;
  /** Minutes, when Resy declares it. */
  duration: number | null;
};

/** "2026-09-30 19:45:00" → "19:45". Venue-local; never parsed as an instant. */
function slotTime(raw: unknown): string | null {
  const m = String(raw ?? "").match(/(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : null;
}

function parseSlots(payload: any): ResySlot[] {
  const venues = payload?.results?.venues ?? [];
  const out: ResySlot[] = [];
  for (const venue of venues) {
    for (const slot of venue?.slots ?? []) {
      const token = slot?.config?.token;
      const time = slotTime(slot?.date?.start);
      if (!token || !time) continue;
      out.push({
        configToken: String(token),
        time,
        type: slot?.config?.type ?? null,
        duration: typeof slot?.config?.duration === "number" ? slot.config.duration : null,
      });
    }
  }
  return out;
}

/**
 * Open tables for one venue/day/party size.
 *
 * `lat`/`long` are required by the endpoint but irrelevant when venue_id is
 * pinned; 0/0 is what the web app sends for a direct venue lookup.
 *
 * `fast` swaps in the short timeout for the drop race — a 10s hang there would
 * burn the entire window.
 */
export async function findSlots(args: {
  venueId: number;
  day: string; // YYYY-MM-DD
  partySize: number;
  fast?: boolean;
}): Promise<ResySlot[]> {
  const payload = await resyFetch<any>("/4/find", {
    query: {
      lat: 0,
      long: 0,
      day: args.day,
      party_size: args.partySize,
      venue_id: args.venueId,
    },
    timeoutMs: args.fast ? RACE_FIND_TIMEOUT_MS : REQUEST_TIMEOUT_MS,
  });
  return parseSlots(payload);
}

// ---------------------------------------------------------------------------
// Booking
// ---------------------------------------------------------------------------

/**
 * What a slot will actually charge, in CENTS, from a /3/details `payment` block.
 *
 * The single unit-conversion boundary in this codebase, and therefore worth its
 * own function and its own tests. Resy reports these amounts in DOLLARS while
 * everything here counts integer cents: Chef's Table at Brooklyn Fare returns
 * `{price_per_unit: 200, quantity: 2, total: 400}` and renders it
 * "$200.00 x 2 = $400.00". Read `total` as cents and a $400 prix fixe sails
 * under a $50 cap.
 *
 * `total` already includes quantity, fees and tax — do NOT multiply by party
 * size. `reservation_charge` is the fallback for payloads that omit `total`.
 */
export function chargeCentsFrom(payment: any): number {
  const amounts = payment?.amounts;
  if (!amounts) return 0;
  const dollars = Number(amounts.total ?? amounts.reservation_charge ?? 0);
  if (!Number.isFinite(dollars) || dollars <= 0) return 0;
  return Math.round(dollars * 100);
}

export type SlotDetails = {
  /** Short-lived (~5 min). The actual right to book. */
  bookToken: string;
  /** What booking this will actually CHARGE, in cents. 0 for an ordinary table. */
  chargeCents: number;
  /** Resy's own words: "free", "prix fixe", "deposit", … */
  chargeType: string;
  /** Resy's own rendering, e.g. "$200.00 x 2 = $400.00". Quote this, don't recompute it. */
  chargeLabel: string | null;
  /** The account's default card, or null if there genuinely isn't one. */
  paymentMethodId: number | null;
  hasCardOnFile: boolean;
};

/**
 * Resolve a slot into a book_token, plus what booking it will really cost.
 *
 * ⚠️ AMOUNTS ARE IN DOLLARS, NOT CENTS. Verified against Chef's Table at
 * Brooklyn Fare, which returns `price_per_unit: 200, quantity: 2, total: 400`
 * alongside the label "$200.00 x 2 = $400.00". Everything else in this codebase
 * counts money in integer cents, so this is the one conversion boundary — get it
 * backwards and a $400 prix fixe reads as $4.
 *
 * ⚠️ There is NO `deposit_fee` field. An earlier version read
 * `config.deposit_fee`, which does not exist on any response, so every venue
 * priced as free and the owner's deposit cap was never enforced at all. The
 * charge lives at `payment.amounts.total`, and `payment.config.type` names it.
 */
export async function slotDetails(args: {
  configToken: string;
  day: string;
  partySize: number;
  fast?: boolean;
}): Promise<SlotDetails> {
  const body = await resyFetch<any>("/3/details", {
    method: "POST",
    json: { config_id: args.configToken, day: args.day, party_size: args.partySize },
    timeoutMs: args.fast ? RACE_WRITE_TIMEOUT_MS : REQUEST_TIMEOUT_MS,
  });

  const bookToken = body?.book_token?.value;
  if (!bookToken) throw new ResyError("Resy didn't return a booking token for that slot", "gone");

  const chargeCents = chargeCentsFrom(body?.payment);

  // Prefer the card the owner actually made default rather than array order.
  const methods: any[] = body?.user?.payment_methods ?? body?.payment_methods ?? [];
  const chosen = methods.find((m) => m?.is_default) ?? methods[0] ?? null;

  return {
    bookToken: String(bookToken),
    chargeCents,
    chargeType: String(body?.payment?.config?.type ?? "unknown"),
    chargeLabel: body?.payment?.display?.buy?.value || null,
    paymentMethodId: chosen?.id == null ? null : Number(chosen.id),
    hasCardOnFile: chosen != null,
  };
}

export type Booking = {
  resyToken: string;
  reservationId: string | null;
};

/**
 * Commit the booking. This spends real money and creates a real obligation.
 *
 * Form-encoded, not JSON — Resy's /3/book rejects a JSON body. The payment
 * method rides along as a JSON-in-a-form-field, which is unusual enough to look
 * like a bug and isn't.
 *
 * ⚠️ ALWAYS PASS THE CARD WHEN THE ACCOUNT HAS ONE, even for a $0 table. Plenty
 * of venues require a card ON FILE to hold a free reservation — they charge only
 * for a no-show — and Resy answers a missing `struct_payment_method` with a bare
 * 402 that is indistinguishable from a real deposit demand. An earlier version
 * attached the card only when it believed a deposit was due, so those venues
 * failed to book and reported "no card on file" at an owner who had two.
 *
 * Attaching a card does not authorise a charge: the amount is fixed by the
 * booking config (see slotDetails), which is where the owner's cap is enforced.
 */
export async function book(args: {
  bookToken: string;
  paymentMethodId?: number | null;
  fast?: boolean;
}): Promise<Booking> {
  const form: Record<string, string | number> = { book_token: args.bookToken };
  if (args.paymentMethodId != null) {
    form.struct_payment_method = JSON.stringify({ id: args.paymentMethodId });
  }

  const body = await resyFetch<any>("/3/book", {
    method: "POST",
    form,
    timeoutMs: args.fast ? RACE_WRITE_TIMEOUT_MS : REQUEST_TIMEOUT_MS,
  });

  const resyToken = body?.resy_token;
  if (!resyToken) throw new ResyError("Resy accepted the booking but returned no token", "transport");
  return {
    resyToken: String(resyToken),
    reservationId: body?.reservation_id != null ? String(body.reservation_id) : null,
  };
}

export async function cancelBooking(resyToken: string): Promise<void> {
  await resyFetch("/3/cancel", { method: "POST", form: { resy_token: resyToken } });
}

export type Reservation = {
  resyToken: string;
  reservationId: string | null;
  venueId: number | null;
  venueName: string | null;
  day: string;
  time: string | null;
  partySize: number | null;
  slotType: string | null;
};

/**
 * The owner's reservations.
 *
 * ⚠️ Defaults to UPCOMING. Without `type` the endpoint returns history, which is
 * useless for the two things this is actually for — "what do I have booked?" and
 * verifying that a timed-out booking landed.
 *
 * ⚠️ `venue` here is `{id, currency}` with NO name; the time is `time_slot`, not
 * `date.start`. An earlier parser read both from the wrong place and returned
 * every row as "Unknown" at an unparseable date, which is exactly why a booking
 * that timed out couldn't be confirmed against the account.
 */
export async function myReservations(type: "upcoming" | "past" = "upcoming"): Promise<Reservation[]> {
  const body = await resyFetch<any>("/3/user/reservations", {
    query: { limit: 50, offset: 1, type },
  });
  return (body?.reservations ?? []).map((r: any) => ({
    resyToken: String(r?.resy_token ?? ""),
    reservationId: r?.reservation_id != null ? String(r.reservation_id) : null,
    venueId: typeof r?.venue?.id === "number" ? r.venue.id : null,
    venueName: r?.venue?.name ?? null,
    day: String(r?.day ?? "").slice(0, 10),
    time: slotTime(r?.time_slot),
    partySize: typeof r?.num_seats === "number" ? r.num_seats : null,
    slotType: r?.config?.type ?? null,
  }));
}

/**
 * Did we already book this venue on this day? The answer to "the write timed
 * out — did it land?"
 *
 * A timeout on /3/book is NOT a failure. It is an UNKNOWN: the request may have
 * reached Resy and committed before the client gave up waiting. Treating that as
 * a loss is how a snipe reports a miss for a table the owner now holds and has
 * been charged for. Any write that times out must be verified against the
 * account before its outcome is announced.
 */
export async function findReservationFor(
  venueId: number,
  day: string,
): Promise<Reservation | null> {
  const mine = await myReservations("upcoming");
  return mine.find((r) => r.venueId === venueId && r.day === day) ?? null;
}

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

/**
 * A row of `resy_snipes`. Mirrors FlightWatchRow in #lib/flights.js: the shape
 * lives beside the logic that reads it, and queries declare it with
 * `.returns<ResySnipeRow[]>()` rather than relying on the Supabase client
 * inferring a hand-written select string.
 *
 * Postgres `time` columns come back as "HH:MM:SS" — one segment longer than the
 * "HH:MM" everything in this file works in. Normalise with hhmm() on the way in.
 */
export type ResySnipeRow = {
  id: string;
  channel: "imessage" | "slack";
  phone: string | null;
  slack_target: { channelId: string } | null;
  venue_id: number;
  venue_name: string;
  venue_slug: string | null;
  reservation_date: string;
  party_size: number;
  earliest_time: string;
  latest_time: string;
  preferred_time: string | null;
  slot_types: string[] | null;
  max_deposit_cents: number;
  /**
   * Exactly ONE of these shapes is set — enforced by resy_snipes_timing_shape.
   * `drop_at` is the exact instant, for a venue whose release time is genuinely
   * known. The watch window is for the normal case where it isn't: Resy exposes
   * no booking-window metadata, so a guessed second loses silently while a
   * watched window only costs a few seconds of detection latency.
   */
  drop_at: string | null;
  watch_from: string | null;
  watch_until: string | null;
  status: "armed" | "firing" | "booked" | "missed" | "failed" | "cancelled";
  fired_at: string | null;
  /** When a watch first saw inventory — the measurement, written once. */
  detected_at: string | null;
  resy_token: string | null;
  reservation_id: string | null;
  booked_time: string | null;
  booked_slot_type: string | null;
  deposit_paid_cents: number | null;
  attempts: number;
  last_error: string | null;
};

/** "19:45:00" (Postgres `time`) → "19:45". Safe on already-short values. */
export function hhmm(t: string): string {
  return t.slice(0, 5);
}

// ---------------------------------------------------------------------------
// Pure logic — no network, unit-testable
// ---------------------------------------------------------------------------

/** "19:45" → 1185. Venue-local minutes since midnight. */
export function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export function formatTime(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const period = h >= 12 ? "pm" : "am";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${hour}${period}` : `${hour}:${String(m).padStart(2, "0")}${period}`;
}

export type SnipePrefs = {
  earliestTime: string; // "HH:MM"
  latestTime: string;
  preferredTime: string | null;
  /** Ranked; earlier entries win. Null/empty = any table is fine. */
  slotTypes: string[] | null;
};

/**
 * Filter to the owner's pre-authorized window, then rank.
 *
 * The window is a HARD bound, not a preference — it's the authorization the
 * owner granted on the approval card. A 5pm table when he said 7–9 is not a
 * near miss, it's booking something he didn't agree to. Filter first, always.
 *
 * Within the window: preferred slot type wins over clock distance, because
 * "dining room at 8:30" beats "bar at 8:00" for most people who bothered to
 * state a preference. Ties break earlier.
 */
export function rankSlots(slots: ResySlot[], prefs: SnipePrefs): ResySlot[] {
  const lo = toMinutes(prefs.earliestTime);
  const hi = toMinutes(prefs.latestTime);
  const target = prefs.preferredTime ? toMinutes(prefs.preferredTime) : null;
  const types = prefs.slotTypes?.length ? prefs.slotTypes.map((t) => t.toLowerCase()) : null;

  const typeRank = (slot: ResySlot): number => {
    if (!types) return 0;
    const t = (slot.type ?? "").toLowerCase();
    const i = types.findIndex((want) => t.includes(want));
    return i === -1 ? types.length : i; // unlisted types sort last but stay eligible
  };

  return slots
    .filter((s) => {
      const m = toMinutes(s.time);
      return m >= lo && m <= hi;
    })
    .sort((a, b) => {
      const byType = typeRank(a) - typeRank(b);
      if (byType !== 0) return byType;
      if (target !== null) {
        const byClock =
          Math.abs(toMinutes(a.time) - target) - Math.abs(toMinutes(b.time) - target);
        if (byClock !== 0) return byClock;
      }
      return toMinutes(a.time) - toMinutes(b.time);
    });
}

/** A deposit of exactly the cap is allowed; the cap is what he authorized. */
export function depositWithinBounds(depositCents: number, maxDepositCents: number): boolean {
  return depositCents <= maxDepositCents;
}

export function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

/**
 * Owner-local wall clock ("2026-08-31T09:00") → the UTC instant to fire at.
 *
 * Reuses ownerWallClockToUtc from #lib/reminders.js rather than reimplementing
 * offset math — that helper is already tested against DST, including the
 * fall-back day. The repo's rule is that nothing does timezone math twice.
 *
 * ⚠️ CAVEAT: this resolves in the OWNER's timezone, not the venue's. Right for
 * a New Yorker sniping a New York table; an hour off for booking Miami from
 * California. snipe_resy shows the resolved drop time on the approval card in
 * owner-local terms precisely so a wrong one is visible before it's armed.
 */
export function computeDropAt(wallClockLocal: string): Date | null {
  return ownerWallClockToUtc(wallClockLocal);
}

/**
 * Standard Resy pattern: inventory for day D publishes N days earlier at a
 * fixed local time. "30 days out at 9am" for a Sept 30 table → Aug 31, 09:00.
 */
export function dropAtForBookingWindow(
  reservationDate: string,
  daysAhead: number,
  localTime: string,
): Date | null {
  const d = new Date(`${reservationDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() - daysAhead);
  return computeDropAt(`${d.toISOString().slice(0, 10)}T${localTime}`);
}

/**
 * Why a venue can't be sniped headlessly, or null if it can.
 *
 * Called at ARM time. Arming a snipe that is certain to fail at T-0 is worse
 * than refusing: the owner stops looking for a table.
 */
export function snipeBlocker(venue: ResyVenue, partySize: number): string | null {
  if (venue.requiresRecaptcha) {
    return (
      `${venue.name} makes you solve a reCAPTCHA to book, so an automatic booking can't go ` +
      `through there. I can still watch it and text you the moment a table opens.`
    );
  }
  if (venue.isTockInventory) {
    return `${venue.name} is listed on Resy but its tables are actually held on Tock, which I can't book.`;
  }
  if (venue.maxPartySize != null && partySize > venue.maxPartySize) {
    return `${venue.name} only takes parties up to ${venue.maxPartySize} on Resy.`;
  }
  return null;
}

/**
 * What to tell the model when there's no usable Resy session.
 *
 * Centralised because the recovery is counter-intuitive and easy to get wrong in
 * a per-tool message: this account has no password, so the fix is never "check
 * the env vars" — it's a conversation with the owner and six texted digits.
 * Sending him to look for a password he doesn't have wastes his afternoon.
 */
export function notConnectedMessage(kind: ResyErrorKind): string {
  const why =
    kind === "not_configured"
      ? "The owner's Resy account isn't linked yet."
      : "The Resy session has expired and can't renew itself.";
  return (
    `${why} Call connect_resy — Resy will text him a 6-digit code — then ask him to send it to ` +
    `you and pass it to verify_resy_code. Do NOT ask him for a password; this account signs in ` +
    `with codes. It takes about ten seconds and then holds for months.`
  );
}

/** One-line summary for a text message. */
export function describeSlot(venueName: string, day: string, slot: ResySlot): string {
  const type = slot.type ? ` (${slot.type})` : "";
  return `${venueName}, ${day} at ${formatTime(slot.time)}${type}`;
}
