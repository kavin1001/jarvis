import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { config } from "./config.js";
import * as memory from "./memory.js";
import { startTask, taskLaneConfigured } from "./tasks.js";

let client = new Anthropic();

/** Test seam: swap the Claude client for a fake. */
export function setClient(fake: Anthropic) {
  client = fake;
}

export type ChatEvent =
  | { type: "text"; text: string }
  | { type: "task_started"; taskId: string; summary: string }
  | { type: "done" }
  | { type: "error"; message: string };

// Kept byte-identical across requests so the prefix stays cached.
const SYSTEM_PROMPT = `You are Jarvis, a personal assistant on the user's phone. They reach you by voice or text.

Latency-sensitive; begin your visible answer immediately.

How to work:
- Answer directly when you can. Use web_search and web_fetch for anything current or factual you are unsure of.
- When a request needs real work on the web — logging into an account, filling forms, booking, comparing many pages, scraping, or anything that takes more than a minute — call start_task with complete, self-contained instructions, then tell the user in one short sentence that you are on it and they will get a notification.
- Never ask the user for passwords or card numbers in chat. Logins live in a secure vault the background agent can use.
- When the user tells you a lasting preference or fact about themselves, save it with remember. Remove facts with forget when asked.
- Messages that start with [Background task update] are results from tasks you started earlier. Mention them if they are relevant.
- If a user message says it came by voice, reply in one to three short spoken sentences with no markdown, lists, or URLs.`;

const RememberInput = z.object({ fact: z.string().min(1).max(500) });
const ForgetInput = z.object({ fact_id: z.string() });
const StartTaskInput = z.object({
  instructions: z.string().min(1),
  summary: z.string().min(1).max(120),
});

const tools: Anthropic.Beta.BetaToolUnion[] = [
  { type: "web_search_20260209", name: "web_search", max_uses: 5 },
  { type: "web_fetch_20260209", name: "web_fetch", max_uses: 5 },
  {
    name: "remember",
    description: "Save a lasting fact or preference about the user for future conversations.",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: { fact: { type: "string", description: "One short sentence." } },
      required: ["fact"],
    },
  },
  {
    name: "forget",
    description: "Delete a saved fact by its id (shown in brackets in the system prompt).",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: { fact_id: { type: "string" } },
      required: ["fact_id"],
    },
  },
  {
    name: "start_task",
    description:
      "Hand a long-running job to a background agent that has a sandbox, a headless browser and the user's vaulted logins. It runs for minutes and reports back by notification. Use for logins, form filling, bookings, scraping and multi-site research.",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        instructions: {
          type: "string",
          description:
            "Complete instructions for the agent, including everything it needs from this conversation. It cannot see the chat.",
        },
        summary: { type: "string", description: "Five to ten words describing the task, for the notification." },
      },
      required: ["instructions", "summary"],
    },
  },
];

async function buildSystem(): Promise<Anthropic.Beta.BetaTextBlockParam[]> {
  const facts = await memory.listFacts(config.userId);
  const factText =
    facts.length === 0
      ? "You have not saved any facts about the user yet."
      : "Saved facts about the user:\n" + facts.map((f) => `- [${f.id}] ${f.fact}`).join("\n");
  return [
    { type: "text", text: SYSTEM_PROMPT },
    { type: "text", text: factText },
  ];
}

async function runClientTool(
  block: Anthropic.Beta.BetaToolUseBlock,
  conversationId: string,
  emit: (e: ChatEvent) => void,
): Promise<Anthropic.Beta.BetaToolResultBlockParam> {
  const result = (content: string, isError = false): Anthropic.Beta.BetaToolResultBlockParam => ({
    type: "tool_result",
    tool_use_id: block.id,
    content,
    is_error: isError,
  });
  // Inputs stream eagerly, so the server no longer validates them: do it here.
  try {
    switch (block.name) {
      case "remember": {
        const { fact } = RememberInput.parse(block.input);
        const id = await memory.addFact(config.userId, fact);
        return result(`Saved as fact ${id}.`);
      }
      case "forget": {
        const { fact_id } = ForgetInput.parse(block.input);
        const ok = await memory.deleteFact(config.userId, fact_id);
        return result(ok ? "Deleted." : "No fact with that id.", !ok);
      }
      case "start_task": {
        if (!taskLaneConfigured()) {
          return result("Background tasks are not set up on this server yet. Tell the user.", true);
        }
        const { instructions, summary } = StartTaskInput.parse(block.input);
        const taskId = await startTask(config.userId, conversationId, instructions, summary);
        emit({ type: "task_started", taskId, summary });
        return result(`Task ${taskId} started. Tell the user briefly that you are on it.`);
      }
      default:
        return result(`Unknown tool ${block.name}`, true);
    }
  } catch (err) {
    if (err instanceof z.ZodError) return result(`Invalid input: ${err.message}`, true);
    throw err;
  }
}

function textOf(content: Anthropic.Beta.BetaContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/** One user turn: store it, stream Claude's reply, run tools, store everything. */
export async function runTurn(opts: {
  conversationId: string;
  text: string;
  source: "text" | "voice";
  emit: (e: ChatEvent) => void;
}) {
  const { conversationId, text, source, emit } = opts;

  const userContent: Anthropic.Beta.BetaTextBlockParam[] = [];
  for (const update of await memory.takePendingTaskUpdates(conversationId)) {
    userContent.push({ type: "text", text: `[Background task update]\n${update}` });
  }
  if (source === "voice") userContent.push({ type: "text", text: "(Sent by voice.)" });
  userContent.push({ type: "text", text });
  await memory.appendMessage(conversationId, "user", userContent, text, source);

  const system = await buildSystem();
  const messages = await memory.getApiHistory(conversationId);
  let jsonRetries = 0;

  for (let iteration = 0; iteration < 10; iteration++) {
    const stream = client.beta.messages.stream({
      model: config.fastModel,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01", "compact-2026-01-12"],
      fallbacks: "default",
      context_management: { edits: [{ type: "compact_20260112" }] },
      cache_control: { type: "ephemeral" },
      output_config: { effort: config.fastEffort },
      system,
      tools,
      messages,
    });
    stream.on("text", (delta) => emit({ type: "text", text: delta }));

    let message: Anthropic.Beta.BetaMessage;
    try {
      message = await stream.finalMessage();
      jsonRetries = 0;
    } catch (err) {
      // Only an unparseable eager tool input is retried; API errors propagate.
      if (err instanceof Anthropic.APIError || jsonRetries++ >= 2) throw err;
      continue;
    }

    if (message.stop_reason === "refusal") {
      // Not stored: a refused turn is not valid history to send back.
      emit({ type: "text", text: "Sorry, I can't help with that one." });
      break;
    }

    const toolUses = message.content.filter(
      (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use",
    );
    if (toolUses.length > 0 && message.stop_reason === "max_tokens") {
      throw new Error("Tool input truncated at max_tokens");
    }
    // Run tools before storing, so a failure never leaves a tool_use without its result.
    const results = await Promise.all(toolUses.map((b) => runClientTool(b, conversationId, emit)));

    messages.push({ role: "assistant", content: message.content });
    await memory.appendMessage(conversationId, "assistant", message.content, textOf(message.content) || null);
    if (results.length > 0) {
      messages.push({ role: "user", content: results });
      await memory.appendMessage(conversationId, "user", results, null, "system");
      continue;
    }
    if (message.stop_reason !== "pause_turn") break;
  }

  emit({ type: "done" });
}
