import Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/app.js";
import { pool } from "../src/db.js";
import { savePushToken } from "../src/push.js";
import { setStatusClient } from "../src/status.js";
import { auth, resetDb } from "./helpers.js";

beforeEach(resetDb);
afterAll(() => pool.end());

const withModels = (retrieve: () => Promise<unknown>) => setStatusClient({ models: { retrieve } } as unknown as Anthropic);
const status = async () => (await app.request("/api/status", { headers: auth })).json();

describe("server status", () => {
  it("reports what is set up, without secrets", async () => {
    withModels(async () => ({ id: "claude-opus-5-5" }));
    await savePushToken("me", "ExponentPushToken[abc]");
    const body = await status();
    expect(body).toMatchObject({ claude: "ok", task_lane: false, google: false, push_devices: 1 });
    expect(JSON.stringify(body)).not.toMatch(/sk-|ExponentPushToken/);
  });

  it("says when the API key is rejected", async () => {
    withModels(async () => {
      throw new Anthropic.AuthenticationError(401, { error: { message: "invalid x-api-key" } }, "invalid x-api-key", new Headers());
    });
    expect((await status()).claude).toBe("invalid_key");
  });

  it("needs the app token", async () => {
    expect((await app.request("/api/status")).status).toBe(401);
  });
});
