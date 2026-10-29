import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { query } from "./db.js";
import { googleConfigured } from "./google.js";
import { taskLaneConfigured } from "./tasks.js";

let client = new Anthropic();

/** Test seam: swap the Claude client for a fake. */
export function setStatusClient(fake: Anthropic) {
  client = fake;
  cached = null;
}

type ClaudeStatus = "ok" | "invalid_key" | "no_access" | "model_not_found" | "unreachable" | "error";
let cached: { at: number; value: ClaudeStatus } | null = null;

/** Whether the API key works and can use the fast model. Looking a model up costs nothing. */
async function claudeStatus(): Promise<ClaudeStatus> {
  if (cached && Date.now() - cached.at < (cached.value === "ok" ? 60_000 : 10_000)) return cached.value;
  let value: ClaudeStatus;
  try {
    await client.models.retrieve(config.fastModel);
    value = "ok";
  } catch (err) {
    value =
      err instanceof Anthropic.AuthenticationError
        ? "invalid_key"
        : err instanceof Anthropic.PermissionDeniedError
          ? "no_access"
          : err instanceof Anthropic.NotFoundError
            ? "model_not_found"
            : err instanceof Anthropic.APIConnectionError
              ? "unreachable"
              : "error";
  }
  cached = { at: Date.now(), value };
  return value;
}

/** What is set up on the server, for the app's setup checklist. Booleans only, never secrets. */
export async function serverStatus(userId: string) {
  const [push] = await query<{ n: number }>("SELECT count(*)::int AS n FROM push_tokens WHERE user_id = $1", [userId]);
  return {
    claude: await claudeStatus(),
    fast_model: config.fastModel,
    daily_budget_usd: config.dailyBudgetUsd,
    task_lane: taskLaneConfigured(),
    task_vault: Boolean(config.taskVaultId),
    google: googleConfigured(),
    connector_secret: Boolean(process.env.CONNECTOR_SECRET),
    push_devices: push.n,
  };
}
