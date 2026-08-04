import { agentBrowserRevalidationKey, installAgentBrowser } from "@agent-browser/eve/sandbox";
import { defineSandbox } from "eve/sandbox";
import { vercel } from "eve/sandbox/vercel";

/**
 * Pre-install agent-browser (and Chromium) into the sandbox template so browser
 * tools don't pay a cold install on first use mid-conversation.
 *
 * ⚠️ THE PREWARM IS AN OPTIMISATION AND MUST NEVER FAIL THE BUILD. It installs
 * ~30 Chromium system libraries via apt inside the sandbox, which depends on
 * Debian mirrors and package names that drift (note the `t64` fallbacks in
 * agent-browser's own dependency list — that churn is ongoing). On 2026-08-04
 * this started failing outright: one deploy hung 11 minutes and was terminated,
 * the retry failed in 90s with `agent-browser command failed` on the apt step.
 * Both took the whole deployment down with them.
 *
 * Nothing about that is worth blocking a release. `browser({})` defaults to
 * `autoInstall: true`, so a sandbox with no prewarmed template installs
 * agent-browser on first browser tool use instead — slower once per sandbox,
 * and only for conversations that actually browse. Trading a cold start for a
 * dead deploy pipeline is a bad trade, and it is a particularly bad one here:
 * the crons that book restaurant tables at a fixed minute don't touch the
 * browser at all, and were held hostage by an apt mirror.
 *
 * So: log it and carry on. If browser tools start feeling slow on first use,
 * this is why — check the build log for a prewarm warning.
 */
export default defineSandbox({
  backend: vercel({ resources: { vcpus: 2 } }),
  revalidationKey: () => agentBrowserRevalidationKey(),
  async bootstrap({ use }) {
    try {
      const sandbox = await use();
      await installAgentBrowser(sandbox);
    } catch (err) {
      console.warn(
        "[sandbox] agent-browser prewarm failed; browser tools will install on first use instead:",
        err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
      );
    }
  },
});
