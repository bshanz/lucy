/**
 * Link the owner's Resy account from the CLI.
 *
 *   npx tsx --env-file=.env.local scripts/connect-resy.ts --send
 *   npx tsx --env-file=.env.local scripts/connect-resy.ts 272147
 *
 * The normal path is conversational — say "connect resy" to Lucy. This exists
 * for setup and for debugging that path without going through iMessage, since a
 * failure there is otherwise only visible as a shrug in a text message.
 *
 * `--send` is an explicit flag rather than the default because it makes a real
 * phone buzz. Running this script to see what it does should not text anybody.
 *
 * The flow it drives has three steps and two non-obvious turns — see
 * verifyLoginCode in agent/lib/resy.ts. Phone comes from OWNER_PHONE and email
 * from OWNER_EMAIL; neither is ever an argument, because together they are the
 * whole credential.
 */
import { jwtExpiry, requestLoginCode, verifyLoginCode } from "#lib/resy.js";
import { ensureResyStore, loadResyTokens } from "#lib/resy-store.js";

const arg = process.argv[2];

async function main(): Promise<void> {
  ensureResyStore();

  const phone = process.env.OWNER_PHONE;
  if (!phone) throw new Error("OWNER_PHONE is not set");

  if (!arg) {
    const existing = await loadResyTokens();
    console.log(
      existing
        ? "Resy is already linked. Pass a code to re-link, or --send to get a new one."
        : "Resy is not linked.",
    );
    console.log("\n  --send        text a fresh code to the owner's phone");
    console.log("  <code>        exchange a code you already received\n");
    return;
  }

  if (arg === "--send") {
    await requestLoginCode(phone);
    console.log(`Code sent to ••••${phone.slice(-4)}.`);
    console.log("Re-run with the digits: npx tsx --env-file=.env.local scripts/connect-resy.ts <code>");
    return;
  }

  const code = arg.replace(/\D/g, "");
  if (code.length < 4) throw new Error(`"${arg}" doesn't look like a code`);

  const tokens = await verifyLoginCode(phone, code);
  const exp = jwtExpiry(tokens.authToken);

  console.log("Resy linked.");
  console.log(`  refresh token : ${tokens.refreshToken ? "present" : "none — session ends at expiry"}`);
  console.log(
    `  expires       : ${
      exp
        ? `${new Date(exp).toISOString().slice(0, 10)} (${Math.round((exp - Date.now()) / 86400_000)} days)`
        : "no expiry claim on the token"
    }`,
  );
  console.log("\nVerify the rest with: npx tsx --env-file=.env.local scripts/check-resy-live.ts");
}

main().catch((err) => {
  console.error("\nFailed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
