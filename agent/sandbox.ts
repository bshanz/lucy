import { agentBrowserRevalidationKey, installAgentBrowser } from "@agent-browser/eve/sandbox";
import { defineSandbox } from "eve/sandbox";
import { vercel } from "eve/sandbox/vercel";

// Pre-install agent-browser (and Chromium) into the sandbox template so
// browser tools don't pay a cold install on first use mid-conversation.
export default defineSandbox({
  backend: vercel({ resources: { vcpus: 2 } }),
  revalidationKey: () => agentBrowserRevalidationKey(),
  async bootstrap({ use }) {
    const sandbox = await use();
    await installAgentBrowser(sandbox);
  },
});
