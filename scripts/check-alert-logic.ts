/**
 * Checks the flight-alert state machine. Run with `npx tsx scripts/check-alert-logic.ts`.
 *
 * evaluateAlert is the one piece of this feature that can quietly ruin it: two
 * of its three triggers are LEVEL predicates, so a fare parked below Google's
 * typical range would text the owner every day for weeks and get Lucy muted
 * outright. Case 2 below is that scenario. Costs no SerpAPI quota — pure logic.
 */
import { evaluateAlert } from "#lib/flights.js";

const TYPICAL: [number, number] = [520, 890];
const recent = new Date(Date.now() - 3600_000).toISOString();
const old = new Date(Date.now() - 5 * 24 * 3600_000).toISOString();

let failures = 0;
function check(name: string, got: boolean, want: boolean, note = "") {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? ` — ${note}` : ""}`);
}

// 1. Day after track_flight: alerted_price was seeded from the same search.
let d = evaluateAlert({
  currentPrice: 480, lastPrice: 480, alertedPrice: 480, alertedAt: recent,
  targetPrice: null, baselinePrice: 480, typicalRange: TYPICAL,
});
check("day 2, price unchanged below typical", d.alert, false, d.suppressedBy);

// 2. THE feature-killer: same sub-typical price six weeks later.
d = evaluateAlert({
  currentPrice: 480, lastPrice: 480, alertedPrice: 480, alertedAt: old,
  targetPrice: null, baselinePrice: 480, typicalRange: TYPICAL,
});
check("day 42, still parked below typical", d.alert, false, d.suppressedBy);

// 3. A genuinely better fare must still get through.
d = evaluateAlert({
  currentPrice: 400, lastPrice: 480, alertedPrice: 480, alertedAt: old,
  targetPrice: null, baselinePrice: 480, typicalRange: TYPICAL,
});
check("further real drop 480 -> 400", d.alert, true, d.headline);

// 4. ...but not while the 3-day cooldown is running.
d = evaluateAlert({
  currentPrice: 400, lastPrice: 480, alertedPrice: 480, alertedAt: recent,
  targetPrice: null, baselinePrice: 480, typicalRange: TYPICAL,
});
check("same drop inside cooldown", d.alert, false, d.suppressedBy);

// 5. Recovery re-arms, without alerting on the way up.
d = evaluateAlert({
  currentPrice: 700, lastPrice: 480, alertedPrice: 480, alertedAt: old,
  targetPrice: null, baselinePrice: 480, typicalRange: TYPICAL,
});
check("recovered to 700: rearm set", d.rearm, true);
check("recovered to 700: no alert", d.alert, false);

// 6. After re-arming, the next dip is news again.
d = evaluateAlert({
  currentPrice: 470, lastPrice: 700, alertedPrice: null, alertedAt: old,
  targetPrice: null, baselinePrice: 480, typicalRange: TYPICAL,
});
check("dip again after rearm", d.alert, true, d.headline);

// 7. Never on the first poll.
d = evaluateAlert({
  currentPrice: 400, lastPrice: null, alertedPrice: null, alertedAt: null,
  targetPrice: 500, baselinePrice: 400, typicalRange: TYPICAL,
});
check("first poll", d.alert, false, d.suppressedBy);

// 8. Meaningful drop that is still ABOVE the typical range.
d = evaluateAlert({
  currentPrice: 800, lastPrice: 950, alertedPrice: null, alertedAt: null,
  targetPrice: null, baselinePrice: 950, typicalRange: TYPICAL,
});
check("950 -> 800, above typical", d.alert, true, d.headline);

// 9. Noise must not fire: $30 off $900 is 3.3%.
d = evaluateAlert({
  currentPrice: 870, lastPrice: 900, alertedPrice: null, alertedAt: null,
  targetPrice: null, baselinePrice: 900, typicalRange: TYPICAL,
});
check("900 -> 870 noise", d.alert, false);

// 10. Owner target beats Google's opinion.
d = evaluateAlert({
  currentPrice: 690, lastPrice: 700, alertedPrice: null, alertedAt: null,
  targetPrice: 700, baselinePrice: 900, typicalRange: TYPICAL,
});
check("under owner target, inside typical", d.alert, true, d.headline);

// 11. No insights at all (thin route) -> baseline fallback.
d = evaluateAlert({
  currentPrice: 800, lastPrice: 1000, alertedPrice: null, alertedAt: null,
  targetPrice: null, baselinePrice: 1000, typicalRange: null,
});
check("no price_insights, 20% under baseline", d.alert, true, d.headline);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
