// One-off: create (and verify) the Google grant for Lucy's Gmail access.
// The grant is stored under a fixed synthetic user subject ("owner") because
// Connect's authorization flow only supports user subjects.
//
// Usage:
//   vercel link            # once, if the repo isn't linked to the project
//   vercel env pull .env.local
//   GMAIL_CONNECTOR_UID="<uid from Vercel Connect page>" \
//     node --env-file=.env.local scripts/authorize-gmail.mjs
//
// Open the printed URL and sign into Google AS the owner's Google account. The
// script polls until the grant lands, then calls the Gmail API to confirm
// which mailbox it's bound to.
//
// NOTE: grants are bucketed by the CALLER's environment. This script creates
// a DEVELOPMENT grant (vercel env pull mints dev OIDC tokens). Production
// needs its own grant via the deployed /eve/v1/gmail/authorize route.

import { startAuthorization, getToken } from "@vercel/connect";

const OWNER_EMAIL = (process.env.OWNER_EMAIL || "").toLowerCase();
if (!OWNER_EMAIL) {
  console.error("Set OWNER_EMAIL to the Google account this grant should belong to.");
  process.exit(1);
}

const connector = process.env.GMAIL_CONNECTOR_UID;
if (!connector) {
  console.error("Set GMAIL_CONNECTOR_UID (the connector UID from the Vercel Connect page).");
  process.exit(1);
}

// Must match agent/lib/gmail.ts. The explicit issuer keeps the subject
// environment-independent.
const subject = {
  type: "user",
  id: process.env.GMAIL_CONNECT_SUBJECT || "owner",
  issuer: "lucy",
};

// If a valid grant already exists, skip straight to verification.
let token = await getToken(connector, { subject, scopes: ["*"] }).catch(() => null);

if (!token) {
  // scopes: ["*"] = "use the connector's configured default scopes" — without
  // it Connect sends no scope param and Google 400s (Missing required
  // parameter: scope).
  const auth = await startAuthorization(connector, { subject, scopes: ["*"] });
  console.log(`\nOpen this URL and sign into Google AS ${OWNER_EMAIL}:\n`);
  console.log(`  ${auth.url}\n`);
  console.log("Waiting for the grant (polling for up to 5 minutes)...");

  const deadline = Date.now() + 5 * 60_000;
  while (!token && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    token = await getToken(connector, { subject, scopes: ["*"] }).catch(() => null);
    process.stdout.write(".");
  }
  console.log("");
  if (!token) {
    console.error("Timed out waiting for the grant. Re-run after completing the consent screen.");
    process.exit(1);
  }
}

const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
  headers: { authorization: `Bearer ${token}` },
});
if (!res.ok) {
  console.error(`Gmail API check failed: ${res.status} ${await res.text()}`);
  process.exit(1);
}
const profile = await res.json();
console.log(`\n✓ Grant works. Mailbox: ${profile.emailAddress}`);
if (profile.emailAddress?.toLowerCase() !== OWNER_EMAIL) {
  console.warn(
    `⚠ That is NOT ${OWNER_EMAIL} — you authorized the wrong Google account.\n` +
      "  Revoke the grant (Connect dashboard) and re-run, signing in as the right account.",
  );
}
