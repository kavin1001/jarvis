// One-time setup for the task lane: creates the sandbox environment and the
// background agent, then prints the IDs to put in .env. Re-running creates new
// ones, so run it once (or after changing the config below).
//
// Networking: by default the sandbox can reach only package registries and the
// hosts in TASK_ALLOWED_HOSTS (comma-separated). Pass --unrestricted to give it
// the whole internet; anything in the sandbox could then send data anywhere, so
// keep secrets in the vault rather than in files or prompts.
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();
const unrestricted = process.argv.includes("--unrestricted");
const allowedHosts = (process.env.TASK_ALLOWED_HOSTS ?? "")
  .split(",")
  .map((h) => h.trim())
  .filter(Boolean);

const environment = await client.beta.environments.create({
  name: "jarvis-tasks",
  config: {
    type: "cloud",
    networking: unrestricted
      ? { type: "unrestricted" }
      : { type: "limited", allow_package_managers: true, allow_mcp_servers: true, allowed_hosts: allowedHosts },
  },
});

const agent = await client.beta.agents.create({
  name: "Jarvis task agent",
  model: "claude-opus-5-5",
  system: `You run background jobs for a personal assistant: researching across sites, logging into the user's accounts, filling forms, and collecting data.

To use websites that need a real browser, install Playwright in the sandbox (npm i playwright && npx playwright install --with-deps chromium) and drive headless Chromium from a script. Logins are provided as environment variables whose values are injected securely at the network edge; reference them by name and never print them.

If a site blocks automation (CAPTCHA, unexpected 2FA), stop and explain what the user needs to do.`,
  tools: [
    {
      type: "agent_toolset_20260401",
      default_config: { enabled: true, permission_policy: { type: "auto" } },
      configs: [
        { name: "web_search", enabled: true },
        { name: "web_fetch", enabled: true },
      ],
    },
    {
      type: "custom",
      name: "request_approval",
      description:
        "Ask the user to approve an irreversible or outward-facing step (payment, booking, sending a message, submitting a form, deleting data). Returns 'approved' or 'denied'.",
      input_schema: {
        type: "object",
        properties: { summary: { type: "string", description: "One sentence the user will see on their phone." } },
        required: ["summary"],
      },
    },
  ],
});

console.log(`TASK_ENVIRONMENT_ID=${environment.id}`);
console.log(`TASK_AGENT_ID=${agent.id}`);
