import type Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool, query } from "../src/db.js";
import * as memory from "../src/memory.js";
import { estimateCost, overDailyBudget, recordMessageUsage, summarize, warnNearBudget } from "../src/usage.js";
import { resetDb } from "./helpers.js";

beforeEach(resetDb);
afterAll(() => pool.end());

const usage = (u: Partial<Anthropic.Beta.BetaUsage>) =>
  ({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, server_tool_use: null, ...u }) as Anthropic.Beta.BetaUsage;

describe("usage", () => {
  it("prices tokens, cache and web searches", () => {
    expect(estimateCost("claude-opus-5-5", usage({ input_tokens: 1_000_000 }))).toBeCloseTo(4);
    expect(estimateCost("claude-opus-5-5", usage({ output_tokens: 1_000_000 }))).toBeCloseTo(20);
    expect(estimateCost("claude-sonnet-5-5", usage({ cache_read_input_tokens: 1_000_000 }))).toBeCloseTo(0.2);
    expect(
      estimateCost("claude-opus-5-5", usage({ server_tool_use: { web_search_requests: 3, web_fetch_requests: 0 } as never })),
    ).toBeCloseTo(0.03);
  });

  it("sums chat and task spend and enforces the daily cap", async () => {
    await recordMessageUsage("me", { model: "claude-opus-5-5", usage: usage({ output_tokens: 50_000 }) } as Anthropic.Beta.BetaMessage);
    const conv = await memory.createConversation("me");
    await query("INSERT INTO tasks (user_id, conversation_id, instructions, cost_usd) VALUES ('me', $1, 'x', 0.5)", [conv]);
    await query("INSERT INTO usage_events (user_id, model, cost_usd, created_at) VALUES ('me', 'm', 9, now() - interval '40 days')");

    const s = await summarize("me", "UTC", 2);
    expect(s.today_usd).toBeCloseTo(1.5);
    expect(s.chat_turns_today).toBe(1);
    expect(s.tasks_today).toBe(1);
    expect(await overDailyBudget("me", "UTC", 2)).toBe(false);
    expect(await overDailyBudget("me", "UTC", 1.5)).toBe(true);
    expect(await overDailyBudget("me", "UTC", null)).toBe(false);
  });

  it("warns once a day when spend passes 80% of the cap", async () => {
    const pushes: string[] = [];
    const push = async (_user: string, title: string) => void pushes.push(title);
    await query("INSERT INTO usage_events (user_id, model, cost_usd) VALUES ('me', 'm', 0.7)");
    expect(await warnNearBudget("me", "UTC", 1, push)).toBe(false);
    await query("INSERT INTO usage_events (user_id, model, cost_usd) VALUES ('me', 'm', 0.15)");
    expect(await warnNearBudget("me", "UTC", 1, push)).toBe(true);
    await query("INSERT INTO usage_events (user_id, model, cost_usd) VALUES ('me', 'm', 0.5)");
    expect(await warnNearBudget("me", "UTC", 1, push)).toBe(false);
    expect(pushes).toEqual(["Jarvis is near today's cap"]);
    expect(await warnNearBudget("me", "UTC", null, push)).toBe(false);
  });
});
