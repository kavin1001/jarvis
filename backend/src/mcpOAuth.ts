import { createHash, randomBytes } from "node:crypto";
import { decrypt, encrypt } from "./crypto.js";
import { query } from "./db.js";

/**
 * Sign-in for MCP servers that use OAuth (Notion, Linear and other hosted servers),
 * following the MCP authorization spec: protected resource metadata (RFC 9728),
 * authorization server metadata (RFC 8414), dynamic client registration (RFC 7591),
 * PKCE, and the resource indicator (RFC 8707).
 */

export interface OAuthTokens {
  access_token: string;
  refresh_token?: string;
  expires_at?: number; // ms epoch
  client_id: string;
  client_secret?: string;
  token_endpoint: string;
  resource: string;
  scope?: string;
}

interface Pending {
  serverId: string;
  verifier: string;
  client_id: string;
  client_secret?: string;
  token_endpoint: string;
  resource: string;
  scope?: string;
}

function env() {
  const { PUBLIC_URL, CONNECTOR_SECRET } = process.env;
  if (!PUBLIC_URL || !CONNECTOR_SECRET) return null;
  return { redirectUri: `${PUBLIC_URL.replace(/\/$/, "")}/oauth/mcp/callback`, secret: CONNECTOR_SECRET };
}

export function mcpOAuthConfigured() {
  return env() !== null;
}

const https = (u: unknown): u is string => typeof u === "string" && u.startsWith("https://");

async function getJson(url: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(url, { headers: { Accept: "application/json" } }).catch(() => null);
  if (!res?.ok) return null;
  return (await res.json().catch(() => null)) as Record<string, unknown> | null;
}

/** Well-known URLs for a resource or issuer, path-specific first (RFC 8414 section 3.1, RFC 9728 section 3.1). */
function wellKnown(base: string, name: string) {
  const u = new URL(base);
  const path = u.pathname.replace(/\/$/, "");
  return [...(path ? [`${u.origin}/.well-known/${name}${path}`] : []), `${u.origin}/.well-known/${name}`];
}

/** Finds the authorization server for an MCP server and reads its metadata. */
export async function discover(serverUrl: string) {
  // The server's 401 names its metadata document; otherwise try the well-known locations.
  const probe = await fetch(serverUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  }).catch(() => null);
  if (probe?.ok) throw new Error("This server works without signing in.");
  const challenge = probe?.headers.get("www-authenticate") ?? "";
  const named = challenge.match(/resource_metadata="([^"]+)"/)?.[1];

  let resourceMeta: Record<string, unknown> | null = null;
  for (const url of [...(https(named) ? [named] : []), ...wellKnown(serverUrl, "oauth-protected-resource")]) {
    resourceMeta = await getJson(url);
    if (resourceMeta) break;
  }
  const servers = resourceMeta?.authorization_servers;
  // Older servers (spec 2025-03-26) have no resource metadata and act as their own authorization server.
  const issuer = Array.isArray(servers) && https(servers[0]) ? servers[0] : new URL(serverUrl).origin;

  let authMeta: Record<string, unknown> | null = null;
  for (const url of [...wellKnown(issuer, "oauth-authorization-server"), ...wellKnown(issuer, "openid-configuration")]) {
    authMeta = await getJson(url);
    if (authMeta) break;
  }
  if (!authMeta) throw new Error("This server doesn't offer an OAuth sign-in. Add it with an access token instead.");
  const { authorization_endpoint, token_endpoint, registration_endpoint } = authMeta;
  if (!https(authorization_endpoint) || !https(token_endpoint)) throw new Error("The server's sign-in settings are incomplete.");
  const scopes = resourceMeta?.scopes_supported;
  return {
    authorization_endpoint,
    token_endpoint,
    registration_endpoint: https(registration_endpoint) ? registration_endpoint : null,
    resource: typeof resourceMeta?.resource === "string" ? resourceMeta.resource : serverUrl,
    scope: Array.isArray(scopes) && scopes.length ? scopes.join(" ") : undefined,
  };
}

async function register(endpoint: string, redirectUri: string) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: "Jarvis",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  if (!res.ok) throw new Error(`The server refused to register Jarvis: ${res.status}`);
  const body = (await res.json()) as { client_id?: string; client_secret?: string };
  if (!body.client_id) throw new Error("The server registered Jarvis without a client id.");
  return { client_id: body.client_id, client_secret: body.client_secret };
}

/** Returns the URL to open in a browser. The callback finishes the sign-in. */
export async function startMcpOAuth(userId: string, serverId: string): Promise<string> {
  const e = env();
  if (!e) throw new Error("Set PUBLIC_URL and CONNECTOR_SECRET on the server to sign in to apps.");
  const [server] = await query<{ url: string }>("SELECT url FROM mcp_servers WHERE id = $1 AND user_id = $2", [serverId, userId]);
  if (!server) throw new Error("Server not found");

  const meta = await discover(server.url);
  if (!meta.registration_endpoint) throw new Error("This server doesn't let new apps register. Add it with an access token instead.");
  const client = await register(meta.registration_endpoint, e.redirectUri);

  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(24).toString("base64url");
  const pending: Pending = { serverId, verifier, ...client, token_endpoint: meta.token_endpoint, resource: meta.resource, scope: meta.scope };
  await query(
    "INSERT INTO oauth_states (state, user_id, provider, expires_at, data) VALUES ($1, $2, 'mcp', now() + interval '10 minutes', $3)",
    [state, userId, encrypt(JSON.stringify(pending), e.secret)],
  );

  const params = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: e.redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    resource: meta.resource,
    ...(meta.scope ? { scope: meta.scope } : {}),
  });
  const url = new URL(meta.authorization_endpoint);
  for (const [k, v] of params) url.searchParams.set(k, v);
  return url.toString();
}

async function tokenRequest(t: Pick<OAuthTokens, "token_endpoint" | "client_id" | "client_secret" | "resource">, body: Record<string, string>) {
  const res = await fetch(t.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      ...body,
      client_id: t.client_id,
      resource: t.resource,
      ...(t.client_secret ? { client_secret: t.client_secret } : {}),
    }),
  });
  if (!res.ok) throw new Error(`Token request failed: ${res.status}`);
  const r = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!r.access_token) throw new Error("The server sent no access token.");
  return r as { access_token: string; refresh_token?: string; expires_in?: number };
}

/** Finishes the sign-in. Returns the server's name for the confirmation page. */
export async function handleMcpCallback(code: string, state: string): Promise<string> {
  const e = env();
  if (!e) throw new Error("Sign-in isn't configured on this server.");
  const [claimed] = await query<{ user_id: string; data: string }>(
    "DELETE FROM oauth_states WHERE state = $1 AND provider = 'mcp' AND expires_at > now() RETURNING user_id, data",
    [state],
  );
  if (!claimed) throw new Error("This sign-in link expired. Start again from the app.");
  const p = JSON.parse(decrypt(claimed.data, e.secret)) as Pending;

  const r = await tokenRequest(p, { grant_type: "authorization_code", code, redirect_uri: e.redirectUri, code_verifier: p.verifier });
  const tokens: OAuthTokens = {
    access_token: r.access_token,
    refresh_token: r.refresh_token,
    expires_at: r.expires_in ? Date.now() + r.expires_in * 1000 : undefined,
    client_id: p.client_id,
    client_secret: p.client_secret,
    token_endpoint: p.token_endpoint,
    resource: p.resource,
    scope: p.scope,
  };
  const [row] = await query<{ name: string }>(
    "UPDATE mcp_servers SET oauth = $3, token = NULL WHERE id = $1 AND user_id = $2 RETURNING name",
    [p.serverId, claimed.user_id, encrypt(JSON.stringify(tokens), e.secret)],
  );
  if (!row) throw new Error("That server was removed while you were signing in.");
  return row.name;
}

/** The server's OAuth tokens with an access token good for at least a minute, refreshing if needed. */
export async function freshTokens(serverId: string, sealed: string, secret: string): Promise<OAuthTokens> {
  const tokens = JSON.parse(decrypt(sealed, secret)) as OAuthTokens;
  if (!tokens.expires_at || tokens.expires_at > Date.now() + 60_000) return tokens;
  if (!tokens.refresh_token) throw new Error("expired");
  const r = await tokenRequest(tokens, { grant_type: "refresh_token", refresh_token: tokens.refresh_token });
  const refreshed: OAuthTokens = {
    ...tokens,
    access_token: r.access_token,
    // Servers may rotate the refresh token.
    refresh_token: r.refresh_token ?? tokens.refresh_token,
    expires_at: r.expires_in ? Date.now() + r.expires_in * 1000 : undefined,
  };
  await query("UPDATE mcp_servers SET oauth = $2 WHERE id = $1", [serverId, encrypt(JSON.stringify(refreshed), secret)]);
  return refreshed;
}
