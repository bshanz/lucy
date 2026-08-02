import { nowInOwnerTz, ownerTimezone } from "#lib/reminders.js";

/**
 * SerpAPI Google Flights client + the pure logic behind price alerts.
 *
 * Endpoint: GET https://serpapi.com/search?engine=google_flights&...
 *
 * ⚠️ SerpApi signals failure on TWO different paths, and a client that checks
 * only one is silently broken:
 *   - 401                    → bad API key
 *   - 429                    → out of searches for the month, or hourly rate limit
 *   - 200 + top-level `error`→ the search RAN and found nothing (billed!)
 * Only genuinely failed searches are free, so a no-results response still costs
 * a credit. That is what makes a stale watch expensive, not just useless.
 *
 * ⚠️ The api_key is a QUERY PARAMETER. Never let a raw request URL reach a log
 * line, a thrown message, or a tool's return value (which the model can read
 * and text to the owner). Every message is built from redact() below. This is
 * deliberately UNLIKE googleApiFetch in #lib/gmail.js, which interpolates its
 * full URL — safe there, because Google's credential is a header.
 *
 * Quota: the free tier is 250 searches/month. Results are cached server-side
 * for 1h and cached hits are FREE, so we never pass no_cache — an owner asking
 * about a route the poller just checked costs nothing. A daily poll never hits
 * that cache, though; it only helps same-hour repeats.
 *
 * Round trips: for type=1 `price` is the TOTAL round-trip fare, but `flights[]`
 * holds only the OUTBOUND segments (the return leg needs a second billed call
 * with departure_token). Every caller must label it as such.
 *
 * CRUD lives in the tools and the schedule; this module holds the HTTP client,
 * the row types, and pure formatting/predicates. Env is read lazily — eve
 * imports modules during discovery (`eve info`, build) without secrets present.
 */

const SERPAPI_BASE = "https://serpapi.com";
const REQUEST_TIMEOUT_MS = 20_000;

/** Each active watch costs ~31 searches/month; 6 keeps ~64 free for questions. */
export const MAX_ACTIVE_WATCHES = 6;
/** Google Flights has no inventory past ~11 months — searching is a billed no-op. */
export const MAX_DAYS_AHEAD = 330;
/** Fares stop being actionable and start climbing right before departure. */
export const EXPIRE_DAYS_BEFORE = 2;
/** Credits held back from the poller so the owner can still ask questions. */
export const QUOTA_RESERVE = 15;
/** Interactive lookups are what actually drain the quota — the model explores. */
export const MAX_INTERACTIVE_PER_DAY = 10;

// A drop must clear BOTH bars. Either alone fires on noise: 8% of a $300 fare
// is $24, and $40 off a $2,000 fare is 2%.
export const MIN_DROP_PCT = 0.08;
export const MIN_DROP_ABS = 40;
// How much better than the last alerted price it must get before we speak again.
export const REALERT_MIN_PCT = 0.05;
export const REALERT_MIN_ABS = 25;
// How far it must climb back before a later drop counts as news again.
export const REARM_RISE_PCT = 0.05;
// Hard seatbelt: whatever logic bug survives review, ≤10 texts/watch/month.
export const ALERT_COOLDOWN_MS = 3 * 24 * 3600 * 1000;

export type FlightErrorKind =
  | "quota"
  | "rate_limited"
  | "auth"
  | "no_results"
  | "bad_request"
  | "transport";

export class FlightSearchError extends Error {
  readonly kind: FlightErrorKind;
  constructor(message: string, kind: FlightErrorKind) {
    super(message);
    this.name = "FlightSearchError";
    this.kind = kind;
  }
}

export type TripType = "round_trip" | "one_way";
export type PriceLevel = "low" | "typical" | "high";
export type CabinName = "economy" | "premium_economy" | "business" | "first";

export interface FlightWatchRow {
  id: string;
  channel: "imessage" | "slack";
  phone: string | null;
  slack_target: { channelId: string; threadTs?: string } | null;
  origin_query: string;
  destination_query: string;
  origin_id: string;
  destination_id: string;
  outbound_date: string; // YYYY-MM-DD
  return_date: string | null;
  currency: string;
  adults: number;
  travel_class: number;
  stops: number;
  target_price: number | null;
  baseline_price: number | null;
  last_price: number | null;
  last_price_at: string | null;
  alerted_price: number | null;
  alerted_at: string | null;
  checked_on: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  consecutive_errors: number;
  status: "active" | "paused" | "expired" | "cancelled";
  paused_reason: string | null;
  created_at: string;
}

export interface FlightSegment {
  airline: string;
  flightNumber: string;
  from: { id: string; name: string; time: string };
  to: { id: string; name: string; time: string };
  durationMinutes: number | null;
}

export interface Layover {
  id: string;
  name: string;
  durationMinutes: number | null;
  overnight: boolean;
}

export interface FlightOption {
  price: number;
  totalDurationMinutes: number | null;
  stops: number;
  layovers: Layover[];
  segments: FlightSegment[];
  bookingToken?: string;
}

export interface PriceInsights {
  lowestPrice: number | null;
  priceLevel: PriceLevel | null;
  typicalRange: [number, number] | null;
  historyPoints: number;
}

export interface FlightSearchParams {
  departureId: string;
  arrivalId: string;
  outboundDate: string;
  returnDate?: string | null;
  adults?: number;
  travelClass?: number;
  stops?: number;
  maxPrice?: number;
}

export interface FlightSearchResult {
  tripType: TripType;
  options: FlightOption[]; // price ascending
  cheapest: FlightOption | null;
  cheapestPrice: number | null;
  insights: PriceInsights | null;
  googleFlightsUrl: string;
}

// --- Raw SerpAPI response shapes (only the fields we actually read) ---

interface SerpAirport {
  id?: string;
  name?: string;
  time?: string;
}
interface SerpSegment {
  departure_airport?: SerpAirport;
  arrival_airport?: SerpAirport;
  duration?: number;
  airline?: string;
  flight_number?: string;
}
interface SerpLayover {
  id?: string;
  name?: string;
  duration?: number;
  overnight?: boolean;
}
interface SerpFlight {
  price?: number;
  total_duration?: number;
  flights?: SerpSegment[];
  layovers?: SerpLayover[];
  booking_token?: string;
}
interface SerpResponse {
  error?: string;
  best_flights?: SerpFlight[];
  other_flights?: SerpFlight[];
  price_insights?: {
    lowest_price?: number;
    price_level?: string;
    typical_price_range?: unknown;
    price_history?: unknown;
  };
}

function apiKey(): string {
  const key = process.env.SERPAPI_API_KEY;
  if (!key) throw new Error("SERPAPI_API_KEY is not set");
  return key;
}

/** A request URL safe to put in an error message or a log line. */
function redact(path: string, params: URLSearchParams): string {
  const safe = new URLSearchParams(params);
  safe.set("api_key", "***");
  return `${SERPAPI_BASE}${path}?${safe}`;
}

/**
 * Classify a SerpApi failure. The message text is the only signal that
 * separates "out of searches for the month" (fatal until renewal) from an
 * hourly rate limit (retryable) — both arrive as HTTP 429.
 */
function classify(status: number, body: string): FlightErrorKind {
  if (status === 401) return "auth";
  if (status === 429) {
    return /run out of searches|monthly|upgrade your plan/i.test(body) ? "quota" : "rate_limited";
  }
  return "bad_request";
}

/** Runs one metered Google Flights search. Throws FlightSearchError. */
export async function searchFlights(p: FlightSearchParams): Promise<FlightSearchResult> {
  // type is DERIVED, never model-supplied: type=1 (the SerpApi default) REQUIRES
  // return_date, so a one-way watch with an unset type would fail every day.
  const oneWay = !p.returnDate;
  const params = new URLSearchParams({
    engine: "google_flights",
    api_key: apiKey(),
    departure_id: p.departureId,
    arrival_id: p.arrivalId,
    outbound_date: p.outboundDate,
    type: oneWay ? "2" : "1",
    // Explicit locale/currency: an implicit default that changed would silently
    // reprice every stored last_price and fire bogus alerts.
    currency: "USD",
    hl: "en",
    gl: "us",
    sort_by: "2", // price ascending
    adults: String(p.adults ?? 1),
    travel_class: String(p.travelClass ?? 1),
    stops: String(p.stops ?? 0),
    ...(p.returnDate ? { return_date: p.returnDate } : {}),
    ...(p.maxPrice ? { max_price: String(p.maxPrice) } : {}),
  });

  let res: Response;
  try {
    res = await fetch(`${SERPAPI_BASE}/search?${params}`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new FlightSearchError(
      `SerpApi request failed: ${(err as Error).message} (${redact("/search", params)})`,
      "transport",
    );
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new FlightSearchError(
      `SerpApi search failed (${res.status}): ${detail.slice(0, 300)}`,
      classify(res.status, detail),
    );
  }

  const json = (await res.json()) as SerpResponse;
  // A 200 with a top-level `error` means the search ran and found nothing.
  // It is still billed, so callers must never retry it.
  if (typeof json.error === "string" && json.error.length > 0) {
    throw new FlightSearchError(json.error.slice(0, 300), "no_results");
  }

  // best_flights is documented as not always returned; other_flights alone is
  // a perfectly normal response on thin routes.
  const raw = [...(json.best_flights ?? []), ...(json.other_flights ?? [])];
  const options = raw
    .filter((f): f is SerpFlight & { price: number } => typeof f.price === "number")
    .map(toFlightOption)
    .sort((a, b) => a.price - b.price);

  const insights = toInsights(json);
  const cheapest = options[0] ?? null;

  return {
    tripType: oneWay ? "one_way" : "round_trip",
    options,
    cheapest,
    cheapestPrice: cheapest?.price ?? insights?.lowestPrice ?? null,
    insights,
    googleFlightsUrl: googleFlightsUrl(p),
  };
}

function toFlightOption(f: SerpFlight & { price: number }): FlightOption {
  const segments = (f.flights ?? []).map((s) => ({
    airline: s.airline ?? "Unknown airline",
    flightNumber: s.flight_number ?? "",
    from: { id: s.departure_airport?.id ?? "", name: s.departure_airport?.name ?? "", time: s.departure_airport?.time ?? "" },
    to: { id: s.arrival_airport?.id ?? "", name: s.arrival_airport?.name ?? "", time: s.arrival_airport?.time ?? "" },
    durationMinutes: typeof s.duration === "number" ? s.duration : null,
  }));
  return {
    price: f.price,
    totalDurationMinutes: typeof f.total_duration === "number" ? f.total_duration : null,
    stops: Math.max(0, segments.length - 1),
    layovers: (f.layovers ?? []).map((l) => ({
      id: l.id ?? "",
      name: l.name ?? "",
      durationMinutes: typeof l.duration === "number" ? l.duration : null,
      overnight: l.overnight === true,
    })),
    segments,
    bookingToken: f.booking_token,
  };
}

function toInsights(json: SerpResponse): PriceInsights | null {
  const pi = json.price_insights;
  if (!pi) return null; // absent on one-ways and thin routes — not an error
  const r = pi.typical_price_range;
  // Guard the SHAPE, not the value: `undefined < x` is false, which would
  // silently disable the below-typical trigger instead of erroring.
  const typicalRange: [number, number] | null =
    Array.isArray(r) && typeof r[0] === "number" && typeof r[1] === "number"
      ? [r[0], r[1]]
      : null;
  const level = pi.price_level;
  return {
    lowestPrice: typeof pi.lowest_price === "number" ? pi.lowest_price : null,
    priceLevel: level === "low" || level === "typical" || level === "high" ? level : null,
    typicalRange,
    historyPoints: Array.isArray(pi.price_history) ? pi.price_history.length : 0,
  };
}

/** Remaining quota. This endpoint is free and is NOT counted against it. */
export async function accountQuota(): Promise<{
  totalSearchesLeft: number;
  planRenewalDate: string;
  thisMonthUsage: number;
}> {
  const params = new URLSearchParams({ api_key: apiKey() });
  const res = await fetch(`${SERPAPI_BASE}/account?${params}`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new FlightSearchError(
      `SerpApi account lookup failed (${res.status}): ${detail.slice(0, 300)}`,
      classify(res.status, detail),
    );
  }
  const json = (await res.json()) as {
    total_searches_left?: number;
    plan_renewal_date?: string;
    this_month_usage?: number;
  };
  return {
    totalSearchesLeft: json.total_searches_left ?? 0,
    planRenewalDate: json.plan_renewal_date ?? "",
    thisMonthUsage: json.this_month_usage ?? 0,
  };
}

/**
 * Metro areas where "the airport" is genuinely several airports. departure_id
 * and arrival_id accept comma-separated codes at ONE credit, so covering a
 * whole metro is free — which turns "which London airport?" from a guess the
 * owner never sees into a non-question.
 */
const METROS: Record<string, string> = {
  "new york": "JFK,EWR,LGA",
  nyc: "JFK,EWR,LGA",
  london: "LHR,LGW,STN",
  paris: "CDG,ORY",
  tokyo: "HND,NRT",
  milan: "MXP,LIN",
  rome: "FCO,CIA",
  chicago: "ORD,MDW",
  washington: "IAD,DCA,BWI",
  "washington dc": "IAD,DCA,BWI",
  "san francisco": "SFO,OAK,SJC",
  "bay area": "SFO,OAK,SJC",
  "los angeles": "LAX,BUR,LGB",
  la: "LAX,BUR,LGB",
  toronto: "YYZ,YTZ",
  moscow: "SVO,DME,VKO",
  istanbul: "IST,SAW",
  berlin: "BER",
  stockholm: "ARN,BMA",
  "sao paulo": "GRU,CGH",
  "buenos aires": "EZE,AEP",
  houston: "IAH,HOU",
  dallas: "DFW,DAL",
  miami: "MIA,FLL",
  boston: "BOS",
  seoul: "ICN,GMP",
  shanghai: "PVG,SHA",
  beijing: "PEK,PKX",
  bangkok: "BKK,DMK",
  jakarta: "CGK",
};

const IATA_LIST = /^[A-Z]{3}(,[A-Z]{3}){0,3}$/;

/**
 * Resolve what the owner said into SerpApi's departure_id/arrival_id form.
 * Returns null if it is neither a known metro nor a valid IATA list — the
 * shape check rejects lowercase, 4-letter ICAO (KJFK), and city names typed
 * straight through, all of which would otherwise become billed no-op searches.
 */
export function resolveAirports(spoken: string): string | null {
  const trimmed = spoken.trim();
  const metro = METROS[trimmed.toLowerCase()];
  if (metro) return metro;
  const upper = trimmed.toUpperCase().replace(/\s*,\s*/g, ",");
  return IATA_LIST.test(upper) ? upper : null;
}

export function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Today's date in the owner's timezone, as YYYY-MM-DD. */
export function ownerToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: ownerTimezone(),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** Add whole days to a YYYY-MM-DD date. UTC-anchored, so DST can't shift it. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to`. Negative if `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

export function formatUsd(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

export function formatDuration(minutes: number | null): string {
  if (minutes === null || minutes <= 0) return "unknown";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function formatTripDates(outbound: string, ret: string | null): string {
  const fmt = (d: string) => {
    const [y, m, day] = d.split("-").map(Number);
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      month: "short",
      day: "numeric",
    }).format(new Date(Date.UTC(y, m - 1, day)));
  };
  const year = outbound.slice(0, 4);
  return ret ? `${fmt(outbound)} – ${fmt(ret)}, ${year}` : `${fmt(outbound)}, ${year} (one way)`;
}

export function routeLabel(origin: string, destination: string): string {
  return `${origin} → ${destination}`;
}

export function describeStops(f: FlightOption): string {
  if (f.stops === 0) return "nonstop";
  const via = f.layovers.map((l) => l.id).filter(Boolean).join(", ");
  return `${f.stops} stop${f.stops > 1 ? "s" : ""}${via ? ` (${via})` : ""}`;
}

export function summarizeItinerary(f: FlightOption): string {
  const airlines = [...new Set(f.segments.map((s) => s.airline))].join(" / ");
  return `${airlines || "Unknown airline"}, ${describeStops(f)}, ${formatDuration(f.totalDurationMinutes)}`;
}

const CABINS: CabinName[] = ["economy", "premium_economy", "business", "first"];

export function cabinToCode(c: CabinName): number {
  return CABINS.indexOf(c) + 1;
}

export function cabinFromCode(n: number): CabinName {
  return CABINS[n - 1] ?? "economy";
}

/**
 * A shareable Google Flights link. Google parses the natural-language `q`
 * form reliably; the deep-link format is an opaque encoded blob we can't build.
 */
export function googleFlightsUrl(p: FlightSearchParams): string {
  const q =
    `Flights from ${p.departureId.split(",")[0]} to ${p.arrivalId.split(",")[0]} ` +
    `on ${p.outboundDate}${p.returnDate ? ` through ${p.returnDate}` : " one way"}`;
  return `https://www.google.com/travel/flights?q=${encodeURIComponent(q)}`;
}

export interface RouteInput {
  from: string;
  to: string;
  outboundDate: string;
  returnDate?: string;
}

export type RouteCheck =
  | { ok: true; originId: string; destinationId: string }
  | { ok: false; error: string };

/**
 * Resolve airports and sanity-check dates before anything metered runs.
 * Shared by search_flights and track_flight so the two can never drift apart.
 * Every failure message is written to be self-correcting for the model.
 */
export function checkRoute(input: RouteInput): RouteCheck {
  const originId = resolveAirports(input.from);
  const destinationId = resolveAirports(input.to);
  if (!originId || !destinationId) {
    const bad = !originId ? input.from : input.to;
    return {
      ok: false,
      error:
        `Couldn't turn "${bad}" into airport codes. Pass 3-letter IATA codes yourself — ` +
        `up to 4, comma-separated, e.g. 'LIS' or 'JFK,EWR,LGA'. Don't ask the owner for a code.`,
    };
  }
  if (!isIsoDate(input.outboundDate)) {
    return { ok: false, error: "outboundDate must be a real date in YYYY-MM-DD form, e.g. 2026-10-12." };
  }
  if (input.returnDate && !isIsoDate(input.returnDate)) {
    return { ok: false, error: "returnDate must be a real date in YYYY-MM-DD form, e.g. 2026-10-19." };
  }

  const today = ownerToday();
  if (input.outboundDate < today) {
    return {
      ok: false,
      error: `That departure date is in the past. It is currently ${nowInOwnerTz()} — recompute the date from that and retry.`,
    };
  }
  if (input.returnDate && input.returnDate < input.outboundDate) {
    return { ok: false, error: "The return date is before the departure date — swap them and retry." };
  }
  if (daysBetween(today, input.outboundDate) > MAX_DAYS_AHEAD) {
    return {
      ok: false,
      error:
        "Google Flights only sells about 11 months ahead, so there's nothing to price that far out. " +
        "Tell the owner to ask again closer to the date.",
    };
  }
  return { ok: true, originId, destinationId };
}

/**
 * Turn a thrown FlightSearchError into a message written FOR THE MODEL — one
 * that says whether to retry and how, in the style of create_reminder's
 * "recompute the date from that and retry". A message that only describes the
 * failure gets retried blindly, which on a metered API costs real credits.
 */
export function flightErrorMessage(err: unknown): string {
  if (!(err instanceof FlightSearchError)) {
    return `Flight lookup failed: ${(err as Error).message}`;
  }
  switch (err.kind) {
    case "quota":
      return (
        "Out of flight searches for this month — the quota resets at the start of the next " +
        "billing cycle. Tell the owner plainly that you can't price flights until then. " +
        "Do NOT retry this call."
      );
    case "rate_limited":
      return "The flight price service is rate-limiting right now. Tell the owner to try again in a few minutes; don't retry immediately.";
    case "auth":
      return "The flight price service rejected our credentials. This is a setup problem the owner needs to fix — don't retry.";
    case "no_results":
      return (
        "Google Flights ran the search and found nothing for that route and date. Check the " +
        "airport codes and the date. If a multi-airport city was used, retry ONCE with a single " +
        "primary airport (JFK instead of JFK,EWR,LGA) or a nearby date — then stop."
      );
    case "bad_request":
      return `The flight price service rejected the query: ${err.message}. Fix the airport codes or dates, then retry once.`;
    default:
      return "Couldn't reach the flight price service. Say so plainly and suggest trying later — don't retry now.";
  }
}

// --- The alert predicate -------------------------------------------------

export type AlertReasonKind = "hit_target" | "below_typical" | "below_baseline" | "dropped";

export interface AlertReason {
  kind: AlertReasonKind;
  detail: string;
}

export interface AlertInput {
  currentPrice: number;
  lastPrice: number | null; // what we saw on the previous poll
  alertedPrice: number | null; // price at the last alert we actually sent
  alertedAt: string | null;
  targetPrice: number | null;
  baselinePrice: number | null;
  typicalRange: [number, number] | null;
}

export interface AlertDecision {
  alert: boolean;
  /** Clear alerted_price: the fare recovered, so a later drop is news again. */
  rearm: boolean;
  reasons: AlertReason[];
  /** One clause the poller hands the model, already phrased. */
  headline: string;
  suppressed: boolean;
  suppressedBy?: string;
}

/**
 * Decide whether a price is worth interrupting the owner for.
 *
 * The three triggers the owner chose are OR'd, but two of them are LEVEL
 * predicates: a fare parked below Google's typical range satisfies
 * "below_typical" on every single day it stays there. Left as-is that is 42
 * texts in six weeks, the owner mutes Lucy, and reminders and email triage die
 * with it. So the level predicates are converted to EDGE predicates by four
 * layers of suppression:
 *
 *   1. never on the first poll (track_flight already quoted today's price)
 *   2. a 3-day hard cooldown, as a seatbelt against any bug below it
 *   3. a re-alert floor — must beat the last ALERTED price by 5% or $25
 *   4. re-arm only when the fare recovers 5% above that alerted price, so a
 *      genuine second dip still gets through
 *
 * "dropped" needs none of this: it compares against the previous observation,
 * so it is already an edge predicate.
 *
 * Note `lastPrice` (observation) and `alertedPrice` (suppression) are separate
 * inputs on purpose. Collapsing them into one column makes the drop
 * calculation measure "change since I last texted you" instead of "change
 * since I last looked", which silently swallows gradual declines.
 */
export function evaluateAlert(i: AlertInput): AlertDecision {
  const price = i.currentPrice;
  const none = (rearm: boolean): AlertDecision => ({
    alert: false,
    rearm,
    reasons: [],
    headline: "",
    suppressed: false,
  });

  // Did the fare climb back far enough that we should listen again?
  const rearm =
    i.alertedPrice !== null && price > i.alertedPrice * (1 + REARM_RISE_PCT);
  const effectiveAlerted = rearm ? null : i.alertedPrice;

  const reasons: AlertReason[] = [];

  // (c) The owner's own bar beats Google's opinion, so it leads.
  if (i.targetPrice !== null && price <= i.targetPrice) {
    reasons.push({
      kind: "hit_target",
      detail: `at or under the ${formatUsd(i.targetPrice)} target`,
    });
  }

  // (a) Google's read of the route.
  if (i.typicalRange && price < i.typicalRange[0]) {
    reasons.push({
      kind: "below_typical",
      detail: `below Google's typical range of ${formatUsd(i.typicalRange[0])}–${formatUsd(i.typicalRange[1])}`,
    });
  } else if (!i.typicalRange && i.targetPrice === null && i.baselinePrice !== null) {
    // No insights and no owner target: fall back to "10% off what it cost when
    // he started tracking", so a thin route still produces some signal.
    if (price <= i.baselinePrice * 0.9) {
      reasons.push({
        kind: "below_baseline",
        detail: `10%+ below the ${formatUsd(i.baselinePrice)} it cost when tracking started`,
      });
    }
  }

  // (b) Movement since the previous poll — already an edge predicate.
  if (i.lastPrice !== null && i.lastPrice > price) {
    const drop = i.lastPrice - price;
    if (drop >= MIN_DROP_ABS && drop / i.lastPrice >= MIN_DROP_PCT) {
      const pct = Math.round((drop / i.lastPrice) * 100);
      reasons.push({
        kind: "dropped",
        detail: `down ${formatUsd(drop)} (${pct}%) from ${formatUsd(i.lastPrice)} at the last check`,
      });
    }
  }

  if (reasons.length === 0) return none(rearm);

  // 1. Never on the first poll — track_flight already told him this price.
  if (i.lastPrice === null) {
    return { alert: false, rearm, reasons, headline: "", suppressed: true, suppressedBy: "first poll" };
  }

  // 2. Hard cooldown.
  if (i.alertedAt && Date.now() - new Date(i.alertedAt).getTime() < ALERT_COOLDOWN_MS) {
    return {
      alert: false,
      rearm,
      reasons,
      headline: "",
      suppressed: true,
      suppressedBy: `alerted less than 3 days ago (${i.alertedAt})`,
    };
  }

  // 3. Re-alert floor.
  if (effectiveAlerted !== null) {
    const floor = effectiveAlerted - Math.max(REALERT_MIN_ABS, effectiveAlerted * REALERT_MIN_PCT);
    if (price > floor) {
      return {
        alert: false,
        rearm,
        reasons,
        headline: "",
        suppressed: true,
        suppressedBy: `already alerted at ${formatUsd(effectiveAlerted)}; needs ${formatUsd(Math.floor(floor))} or better`,
      };
    }
  }

  return {
    alert: true,
    rearm: false, // an alert sets alerted_price outright; re-arming is moot
    reasons,
    headline: reasons.map((r) => r.detail).join(", and "),
    suppressed: false,
  };
}
