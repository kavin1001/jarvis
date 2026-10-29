import type Anthropic from "@anthropic-ai/sdk";
import { query } from "./db.js";
import { sendPush } from "./push.js";

// USD per million tokens. Cache writes are the 5-minute rate (1.25x input).
// Keep in step with https://platform.claude.com/docs/en/about-claude/pricing
const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
};
// Web search is billed per search on top of tokens (approximate; check the pricing page).
const WEB_SEARCH_USD = 10 / 1000;

function priceFor(model: string) {
  const key = Object.keys(PRICES).find((k) => model === k || model.startsWith(`${k}-`));
  return PRICES[key ?? "claude-opus-5-5"];
}

export function estimateCost(model: string, usage: Anthropic.Beta.BetaUsage): number {
  const p = priceFor(model);
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const searches = usage.server_tool_use?.web_search_requests ?? 0;
  return (
    (usage.input_tokens * p.input +
      usage.output_tokens * p.output +
      cacheRead * p.cacheRead +
      cacheWrite * p.input * 1.25) /
      1_000_000 +
    searches * WEB_SEARCH_USD
  );
}

export async function recordMessageUsage(userId: string, message: Anthropic.Beta.BetaMessage) {
  const u = message.usage;
  await query(
    `INSERT INTO usage_events (user_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, web_searches, cost_usd)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      userId,
      message.model,
      u.input_tokens,
      u.output_tokens,
      u.cache_read_input_tokens ?? 0,
      u.cache_creation_input_tokens ?? 0,
      u.server_tool_use?.web_search_requests ?? 0,
      estimateCost(message.model, u),
    ],
  );
}

export interface UsageSummary {
  today_usd: number;
  last_7_days_usd: number;
  month_to_date_usd: number;
  chat_turns_today: number;
  tasks_today: number;
  daily_budget_usd: number | null;
}

/** Spend since local midnight, the last 7 days and this calendar month, in the user's time zone. */
export async function summarize(userId: string, timezone: string, dailyBudget: number | null): Promise<UsageSummary> {
  const [row] = await query<{
    today: string;
    week: string;
    month: string;
    turns: string;
    tasks: string;
  }>(
    `WITH bounds AS (
       SELECT date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2 AS day_start,
              date_trunc('month', now() AT TIME ZONE $2) AT TIME ZONE $2 AS month_start
     ), spend AS (
       SELECT created_at, cost_usd, 'chat' AS kind FROM usage_events WHERE user_id = $1
       UNION ALL
       SELECT created_at, cost_usd, 'task' FROM tasks WHERE user_id = $1
     )
     SELECT
       COALESCE(SUM(cost_usd) FILTER (WHERE created_at >= day_start), 0) AS today,
       COALESCE(SUM(cost_usd) FILTER (WHERE created_at >= now() - interval '7 days'), 0) AS week,
       COALESCE(SUM(cost_usd) FILTER (WHERE created_at >= month_start), 0) AS month,
       COUNT(*) FILTER (WHERE kind = 'chat' AND created_at >= day_start) AS turns,
       COUNT(*) FILTER (WHERE kind = 'task' AND created_at >= day_start) AS tasks
     FROM spend, bounds`,
    [userId, timezone],
  );
  return {
    today_usd: Number(row.today),
    last_7_days_usd: Number(row.week),
    month_to_date_usd: Number(row.month),
    chat_turns_today: Number(row.turns),
    tasks_today: Number(row.tasks),
    daily_budget_usd: dailyBudget,
  };
}

/** Share of the daily cap that triggers the warning notification. */
export const WARN_AT = 0.8;

/**
 * Sends one notification per local day once spend passes 80% of the daily cap,
 * so the cap doesn't arrive as a surprise mid-task. Returns whether it sent one.
 */
export async function warnNearBudget(userId: string, timezone: string, dailyBudget: number | null, push = sendPush) {
  if (dailyBudget === null || dailyBudget <= 0) return false;
  const { today_usd } = await summarize(userId, timezone, dailyBudget);
  if (today_usd < dailyBudget * WARN_AT) return false;
  const claimed = await query(
    "INSERT INTO budget_alerts (user_id, day) VALUES ($1, (now() AT TIME ZONE $2)::date) ON CONFLICT DO NOTHING RETURNING day",
    [userId, timezone],
  );
  if (claimed.length === 0) return false;
  const over = today_usd >= dailyBudget;
  await push(
    userId,
    over ? "Jarvis reached today's cap" : "Jarvis is near today's cap",
    `$${today_usd.toFixed(2)} of $${dailyBudget.toFixed(2)} used today. ${over ? "Chat pauses until midnight" : "At the cap, chat pauses until midnight"}; raise DAILY_BUDGET_USD to allow more.`,
  );
  return true;
}

export async function overDailyBudget(userId: string, timezone: string, dailyBudget: number | null) {
  if (dailyBudget === null) return false;
  const s = await summarize(userId, timezone, dailyBudget);
  return s.today_usd >= dailyBudget;
}
