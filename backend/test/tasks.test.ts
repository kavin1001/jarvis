import type Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool, query } from "../src/db.js";
import * as memory from "../src/memory.js";
import { decideApproval, expireApprovals, listTasks, resumeTasks, setTaskClient, startTask } from "../src/tasks.js";
import { resetDb } from "./helpers.js";

/** An async queue standing in for a session's live event stream. */
function liveStream() {
  const items: unknown[] = [];
  let wake: (() => void) | null = null;
  return {
    push(e: unknown) {
      items.push(e);
      wake?.();
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (items.length) yield items.shift();
        await new Promise<void>((r) => (wake = r));
      }
    },
  };
}

function fakeTaskClient(opts: { history?: unknown[]; status?: string } = {}) {
  const stream = liveStream();
  const sent: unknown[] = [];
  const client = {
    beta: {
      sessions: {
        create: async () => ({ id: "sesn_1" }),
        retrieve: async () => ({ id: "sesn_1", status: opts.status ?? "running" }),
        events: {
          stream: async () => stream,
          send: async (_id: string, body: { events: unknown[] }) => void sent.push(...body.events),
          list: async function* () {
            yield* opts.history ?? [];
          },
        },
      },
    },
  };
  setTaskClient(client as unknown as Anthropic);
  return { stream, sent };
}

const until = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timed out");
};

const taskStatus = async (id: string) =>
  (await query<{ status: string }>("SELECT status FROM tasks WHERE id = $1", [id]))[0].status;

beforeEach(resetDb);
afterAll(() => pool.end());

describe("task lane", () => {
  it("asks for approval, passes the answer on, and reports the result", async () => {
    const { stream, sent } = fakeTaskClient();
    const conv = await memory.createConversation("me");
    const taskId = await startTask("me", conv, "Book a table", "Book dinner");
    await until(async () => sent.length === 1); // the kickoff message

    stream.push({ type: "agent.custom_tool_use", id: "evt_ask", name: "request_approval", input: { summary: "Pay $20 deposit" } });
    await until(async () => (await taskStatus(taskId)) === "waiting_approval");

    const [task] = (await listTasks("me")) as { pending_approvals: { id: string; summary: string }[] }[];
    expect(task.pending_approvals.map((a) => a.summary)).toEqual(["Pay $20 deposit"]);
    expect(await decideApproval("me", task.pending_approvals[0].id, "allow")).toBe(true);
    expect(sent.at(-1)).toMatchObject({ type: "user.custom_tool_result", custom_tool_use_id: "evt_ask" });
    expect(JSON.stringify(sent.at(-1))).toContain("approved");
    expect(await taskStatus(taskId)).toBe("running");

    stream.push({ type: "agent.message", id: "evt_msg", content: [{ type: "text", text: "Booked for 7pm." }] });
    stream.push({ type: "session.status_idle", id: "evt_idle", stop_reason: { type: "end_turn" } });
    await until(async () => (await taskStatus(taskId)) === "done");

    expect(await memory.takePendingTaskUpdates(conv)).toEqual(['Task "Book dinner" finished.\n\nBooked for 7pm.']);
  });

  it("forwards tool confirmations and denies stale approvals", async () => {
    const { stream, sent } = fakeTaskClient();
    const conv = await memory.createConversation("me");
    const taskId = await startTask("me", conv, "Clean up files", "Cleanup");
    await until(async () => sent.length === 1);
    stream.push({ type: "agent.tool_use", id: "evt_bash", name: "bash", input: { command: "rm -rf x" }, evaluated_permission: "ask" });
    await until(async () => (await taskStatus(taskId)) === "waiting_approval");

    await query("UPDATE approvals SET created_at = now() - interval '2 days'");
    await expireApprovals();
    expect(sent.at(-1)).toEqual({ type: "user.tool_confirmation", tool_use_id: "evt_bash", result: "deny" });
  });

  it("after a restart, picks up an approval request it missed", async () => {
    const conv = await memory.createConversation("me");
    const [{ id: taskId }] = await query<{ id: string }>(
      "INSERT INTO tasks (user_id, conversation_id, instructions, summary, status, session_id) VALUES ('me', $1, 'x', 'Order', 'running', 'sesn_1') RETURNING id",
      [conv],
    );
    fakeTaskClient({
      status: "idle",
      history: [
        { type: "agent.custom_tool_use", id: "evt_missed", name: "request_approval", input: { summary: "Checkout" } },
        { type: "session.status_idle", id: "evt_i", stop_reason: { type: "requires_action" } },
      ],
    });
    expect(await resumeTasks()).toBe(1);
    await until(async () => (await taskStatus(taskId)) === "waiting_approval");
    const approvals = await query<{ summary: string }>("SELECT summary FROM approvals");
    expect(approvals.map((a) => a.summary)).toEqual(["Checkout"]);
  });

  it("after a restart, finishes a session that ended while the server was down", async () => {
    const conv = await memory.createConversation("me");
    const [{ id: taskId }] = await query<{ id: string }>(
      "INSERT INTO tasks (user_id, conversation_id, instructions, summary, status, session_id) VALUES ('me', $1, 'x', 'Research', 'running', 'sesn_1') RETURNING id",
      [conv],
    );
    fakeTaskClient({
      status: "idle",
      history: [
        { type: "agent.message", id: "evt_m", content: [{ type: "text", text: "Found 3 options." }] },
        { type: "session.status_idle", id: "evt_i", stop_reason: { type: "end_turn" } },
      ],
    });
    await resumeTasks();
    await until(async () => (await taskStatus(taskId)) === "done");
    expect(await memory.takePendingTaskUpdates(conv)).toEqual(['Task "Research" finished.\n\nFound 3 options.']);
  });
});
