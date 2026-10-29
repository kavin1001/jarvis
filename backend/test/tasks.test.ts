import type Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool, query } from "../src/db.js";
import { addServer } from "../src/mcp.js";
import * as memory from "../src/memory.js";
import { deleteAllData } from "../src/account.js";
import { app } from "../src/app.js";
import {
  cancelTask,
  decideApproval,
  expireApprovals,
  listTasks,
  resumeTasks,
  setOutputRetryMs,
  setTaskClient,
  startTask,
} from "../src/tasks.js";
import { auth, resetDb } from "./helpers.js";

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

type OutputFile = { id: string; filename: string; mime_type: string; size_bytes: number };
function fakeTaskClient(opts: { history?: unknown[]; status?: string; files?: OutputFile[] } = {}) {
  const stream = liveStream();
  const sent: unknown[] = [];
  const created: Record<string, unknown>[] = [];
  const vaults = { credentials: [] as unknown[], deleted: [] as string[] };
  const archived: string[] = [];
  const fileLists: unknown[] = [];
  const deletedFiles: string[] = [];
  const client = {
    beta: {
      files: {
        list: async function* (params: unknown) {
          fileLists.push(params);
          yield* opts.files ?? [];
        },
        download: async (id: string) => new Response(`contents of ${id}`),
        delete: async (id: string) => void deletedFiles.push(id),
      },
      agents: {
        retrieve: async (id: string) => ({
          id,
          version: 3,
          tools: [{ type: "agent_toolset_20260401" }],
          mcp_servers: [{ type: "url", name: "github", url: "https://gh.example/mcp" }],
        }),
      },
      vaults: {
        create: async () => ({ id: "vlt_task" }),
        delete: async (id: string) => void vaults.deleted.push(id),
        credentials: { create: async (_v: string, body: unknown) => void vaults.credentials.push(body) },
      },
      sessions: {
        archive: async (id: string) => void archived.push(id),
        create: async (params: Record<string, unknown>) => {
          created.push(params);
          return { id: "sesn_1" };
        },
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
  return { stream, sent, created, vaults, archived, fileLists, deletedFiles };
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

beforeEach(async () => {
  await resetDb();
  setOutputRetryMs(0);
});
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

  it("keeps the files the agent saved and serves them to the app", async () => {
    const files = [{ id: "file_1", filename: "flights.csv", mime_type: "text/csv", size_bytes: 120 }];
    const { stream, sent, fileLists, deletedFiles } = fakeTaskClient({ files });
    const conv = await memory.createConversation("me");
    const taskId = await startTask("me", conv, "Compare flights", "Flights");
    await until(async () => sent.length === 1);
    stream.push({ type: "agent.message", id: "evt_msg", content: [{ type: "text", text: "Saved a comparison." }] });
    stream.push({ type: "session.status_idle", id: "evt_idle", stop_reason: { type: "end_turn" } });
    // The status flips before the files are listed and the update is written, so wait for the update.
    await until(async () => (await memory.getMessages(conv)).some((m) => m.kind === "task_update"));

    expect(fileLists[0]).toMatchObject({ scope_id: "sesn_1" });
    const [update] = await memory.takePendingTaskUpdates(conv);
    expect(update).toContain("Files: flights.csv");
    const [task] = (await listTasks("me")) as { files: unknown[] }[];
    expect(task.files).toEqual([{ id: "file_1", filename: "flights.csv", mime_type: "text/csv", size_bytes: 120 }]);

    const res = await app.request(`/api/tasks/${taskId}/files/file_1`, { headers: auth });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''flights.csv");
    expect(await res.text()).toBe("contents of file_1");
    expect((await app.request(`/api/tasks/${taskId}/files/file_other`, { headers: auth })).status).toBe(404);

    // "Erase everything" removes them from the Files API as well.
    await deleteAllData("me");
    expect(deletedFiles).toEqual(["file_1"]);
  });

  it("gives the task the user's MCP servers, with tokens in a vault it deletes afterwards", async () => {
    process.env.CONNECTOR_SECRET = "s";
    await addServer("me", { name: "notion", url: "https://notion.example/mcp", token: "tok-123" });
    await addServer("me", { name: "github", url: "https://other.example/mcp" }); // the agent already has a "github"
    const { stream, sent, created, vaults } = fakeTaskClient();
    const conv = await memory.createConversation("me");
    const taskId = await startTask("me", conv, "File my notes", "Notes");
    await until(async () => sent.length === 1);

    expect(created[0].vault_ids).toEqual(["vlt_task"]);
    expect(created[0].agent).toMatchObject({
      type: "agent_with_overrides",
      version: 3,
      tools: [{ type: "agent_toolset_20260401" }, { type: "mcp_toolset", mcp_server_name: "notion" }],
      mcp_servers: [
        { type: "url", name: "github", url: "https://gh.example/mcp" },
        { type: "url", name: "notion", url: "https://notion.example/mcp" },
      ],
    });
    expect(JSON.stringify(created[0])).not.toContain("tok-123");
    expect(vaults.credentials).toEqual([
      { display_name: "notion", auth: { type: "static_bearer", mcp_server_url: "https://notion.example/mcp", token: "tok-123" } },
    ]);

    stream.push({
      type: "agent.mcp_tool_use",
      id: "evt_mcp",
      mcp_server_name: "notion",
      name: "create_page",
      input: { title: "Notes" },
      evaluated_permission: "ask",
    });
    await until(async () => (await taskStatus(taskId)) === "waiting_approval");
    const [task] = (await listTasks("me")) as { pending_approvals: { summary: string }[] }[];
    expect(task.pending_approvals[0].summary).toMatch(/^Allow notion create_page\?/);

    stream.push({ type: "session.status_idle", id: "evt_idle", stop_reason: { type: "end_turn" } });
    await until(async () => (await taskStatus(taskId)) === "done");
    expect(vaults.deleted).toEqual(["vlt_task"]);
  });

  it("uses the agent as is when the user has no MCP servers", async () => {
    const { sent, created } = fakeTaskClient();
    const conv = await memory.createConversation("me");
    await startTask("me", conv, "Look something up", "Lookup");
    await until(async () => sent.length === 1);
    expect(typeof created[0].agent).not.toBe("object");
    expect(created[0].vault_ids).toBeUndefined();
  });

  it("cancels a task waiting for approval: interrupts, archives, closes the ask, and notes it", async () => {
    const { stream, sent, archived } = fakeTaskClient();
    const conv = await memory.createConversation("me");
    const taskId = await startTask("me", conv, "Buy the tickets", "Tickets");
    await until(async () => sent.length === 1);
    stream.push({ type: "agent.custom_tool_use", id: "evt_ask", name: "request_approval", input: { summary: "Pay $80" } });
    await until(async () => (await taskStatus(taskId)) === "waiting_approval");

    expect(await cancelTask("someone-else", taskId)).toBe(false);
    expect(await cancelTask("me", taskId)).toBe(true);
    expect(await taskStatus(taskId)).toBe("cancelled");
    expect(sent.at(-1)).toEqual({ type: "user.interrupt" });
    expect(archived).toEqual(["sesn_1"]);
    const [task] = (await listTasks("me")) as { pending_approvals: unknown[] }[];
    expect(task.pending_approvals).toEqual([]);
    expect(await memory.takePendingTaskUpdates(conv)).toEqual(['Task "Tickets" was cancelled by the user.']);

    // The session winding down afterwards doesn't reopen or report it.
    stream.push({ type: "session.status_idle", id: "evt_idle", stop_reason: { type: "end_turn" } });
    await new Promise((r) => setTimeout(r, 50));
    expect(await taskStatus(taskId)).toBe("cancelled");
    expect(await cancelTask("me", taskId)).toBe(false);
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
