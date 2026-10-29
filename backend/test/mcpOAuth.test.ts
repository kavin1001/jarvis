import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app.js";
import { pool } from "../src/db.js";
import { addServer, listServers, mcpRequestParts } from "../src/mcp.js";
import { discover } from "../src/mcpOAuth.js";
import { auth, resetDb } from "./helpers.js";

const realFetch = globalThis.fetch;

/** A fake MCP server and authorization server, following the MCP authorization spec. */
function fakeAuthServer(opts: { resourceMetadata?: boolean; expiresIn?: number } = {}) {
  const calls: { url: string; body?: string }[] = [];
  let challenge = "";
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.includes(".example")) return realFetch(input, init);
    const body = typeof init?.body === "string" ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : undefined;
    calls.push({ url, body });
    const withMeta = opts.resourceMetadata !== false;

    if (url === "https://mcp.example/mcp")
      return new Response("", {
        status: 401,
        headers: withMeta ? { "WWW-Authenticate": 'Bearer resource_metadata="https://mcp.example/.well-known/oauth-protected-resource/mcp"' } : {},
      });
    if (withMeta && url === "https://mcp.example/.well-known/oauth-protected-resource/mcp")
      return json({ resource: "https://mcp.example/mcp", authorization_servers: ["https://auth.example"], scopes_supported: ["read", "write"] });
    const issuer = withMeta ? "https://auth.example" : "https://mcp.example";
    if (url === `${issuer}/.well-known/oauth-authorization-server`)
      return json({
        issuer,
        authorization_endpoint: `${issuer}/authorize?prompt=consent`,
        token_endpoint: `${issuer}/token`,
        registration_endpoint: `${issuer}/register`,
      });
    if (url === `${issuer}/register`) return json({ client_id: "client-1" }, 201);
    if (url === `${issuer}/token`) {
      const form = new URLSearchParams(body);
      if (form.get("grant_type") === "authorization_code") {
        const ok = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url") === challenge;
        if (!ok || form.get("code") !== "the-code") return json({ error: "invalid_grant" }, 400);
        return json({ access_token: "access-1", refresh_token: "refresh-1", expires_in: opts.expiresIn ?? 3600 });
      }
      if (form.get("grant_type") === "refresh_token" && form.get("refresh_token") === "refresh-1")
        return json({ access_token: "access-2", expires_in: 3600 });
      return json({ error: "invalid_grant" }, 400);
    }
    return new Response("not found", { status: 404 });
  });
  return { calls, setChallenge: (c: string) => (challenge = c) };
}

const json = { ...auth, "Content-Type": "application/json" };

async function signIn(server: ReturnType<typeof fakeAuthServer>) {
  const id = await addServer("me", { name: "notes", url: "https://mcp.example/mcp" });
  const started = await app.request(`/api/mcp-servers/${id}/oauth`, { method: "POST", headers: json });
  const { url } = (await started.json()) as { url: string };
  const authorize = new URL(url);
  server.setChallenge(authorize.searchParams.get("code_challenge")!);
  const callback = await app.request(`/oauth/mcp/callback?code=the-code&state=${authorize.searchParams.get("state")}`);
  return { id, authorize, callback };
}

beforeEach(async () => {
  await resetDb();
  process.env.CONNECTOR_SECRET = "s";
  process.env.PUBLIC_URL = "https://jarvis.example.com/";
});
afterEach(() => vi.unstubAllGlobals());
afterAll(() => pool.end());

describe("MCP OAuth sign-in", () => {
  it("discovers, registers, signs in with PKCE, and uses the token in chat", async () => {
    const server = fakeAuthServer();
    const { authorize, callback } = await signIn(server);

    expect(authorize.origin + authorize.pathname).toBe("https://auth.example/authorize");
    expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
      prompt: "consent",
      response_type: "code",
      client_id: "client-1",
      redirect_uri: "https://jarvis.example.com/oauth/mcp/callback",
      code_challenge_method: "S256",
      resource: "https://mcp.example/mcp",
      scope: "read write",
    });
    expect(callback.status).toBe(200);
    expect(await callback.text()).toContain("Jarvis can now use notes");

    const [listed] = await listServers("me");
    expect(listed).toMatchObject({ name: "notes", signed_in: true, has_token: false });
    expect(JSON.stringify(listed)).not.toContain("access-1");

    const { servers } = await mcpRequestParts("me");
    expect(servers).toEqual([{ type: "url", name: "notes", url: "https://mcp.example/mcp", authorization_token: "access-1" }]);
    const registration = server.calls.find((c) => c.url.endsWith("/register"))!;
    expect(JSON.parse(registration.body!)).toMatchObject({ redirect_uris: ["https://jarvis.example.com/oauth/mcp/callback"], token_endpoint_auth_method: "none" });
  });

  it("refreshes an access token that is about to expire, keeping the refresh token", async () => {
    const server = fakeAuthServer({ expiresIn: 30 });
    await signIn(server);
    expect((await mcpRequestParts("me")).servers[0].authorization_token).toBe("access-2");
    // Stored: the next turn uses access-2 without another refresh.
    const refreshes = server.calls.filter((c) => c.body?.includes("grant_type=refresh_token")).length;
    expect((await mcpRequestParts("me")).servers[0].authorization_token).toBe("access-2");
    expect(server.calls.filter((c) => c.body?.includes("grant_type=refresh_token")).length).toBe(refreshes);
  });

  it("falls back to the server's own origin when there is no resource metadata", async () => {
    fakeAuthServer({ resourceMetadata: false });
    const meta = await discover("https://mcp.example/mcp");
    expect(meta).toMatchObject({ token_endpoint: "https://mcp.example/token", resource: "https://mcp.example/mcp", scope: undefined });
  });

  it("rejects a reused or unknown state", async () => {
    const server = fakeAuthServer();
    const { authorize } = await signIn(server);
    const again = await app.request(`/oauth/mcp/callback?code=the-code&state=${authorize.searchParams.get("state")}`);
    expect(again.status).toBe(400);
    expect(await again.text()).toContain("expired");
  });
});
