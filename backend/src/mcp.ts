import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { decrypt, encrypt } from "./crypto.js";
import { query } from "./db.js";
import { freshTokens } from "./mcpOAuth.js";

interface Row {
  id: string;
  name: string;
  url: string;
  token: string | null;
  oauth: string | null;
  enabled: boolean;
  created_at: string;
}

export const NewServer = z.object({
  // The name is what Claude sees as the toolset's server name.
  name: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, "lowercase letters, digits, - and _ (max 40)"),
  url: z
    .string()
    .url()
    .refine((u) => u.startsWith("https://"), "must be an https URL"),
  token: z.string().min(1).max(4000).optional(),
});

function secret() {
  return process.env.CONNECTOR_SECRET || null;
}

/** For the app: never returns the token itself. */
export async function listServers(userId: string) {
  const rows = await query<Row>("SELECT * FROM mcp_servers WHERE user_id = $1 ORDER BY name", [userId]);
  return rows.map(({ token, oauth, ...r }) => ({ ...r, has_token: token !== null, signed_in: oauth !== null }));
}

export async function addServer(userId: string, input: z.infer<typeof NewServer>) {
  if (input.token && !secret()) throw new Error("Set CONNECTOR_SECRET on the server before adding a token");
  const sealed = input.token ? encrypt(input.token, secret()!) : null;
  const [row] = await query<{ id: string }>(
    `INSERT INTO mcp_servers (user_id, name, url, token) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, name) DO UPDATE SET url = $3, token = $4, enabled = true,
       oauth = CASE WHEN mcp_servers.url = $3 AND $4::text IS NULL THEN mcp_servers.oauth ELSE NULL END
     RETURNING id`,
    [userId, input.name, input.url, sealed],
  );
  return row.id;
}

export async function setServerEnabled(userId: string, id: string, enabled: boolean) {
  const rows = await query("UPDATE mcp_servers SET enabled = $3 WHERE id = $1 AND user_id = $2 RETURNING id", [id, userId, enabled]);
  return rows.length > 0;
}

export async function deleteServer(userId: string, id: string) {
  const rows = await query("DELETE FROM mcp_servers WHERE id = $1 AND user_id = $2 RETURNING id", [id, userId]);
  return rows.length > 0;
}

/** The request fields for the enabled servers, in a stable order so the cached prefix holds. */
export async function mcpRequestParts(userId: string): Promise<{
  servers: Anthropic.Beta.BetaRequestMCPServerURLDefinition[];
  toolsets: Anthropic.Beta.BetaToolUnion[];
}> {
  const usable = await enabledServers(userId);
  return {
    servers: usable.map((r) => ({
      type: "url",
      name: r.name,
      url: r.url,
      ...(r.token ? { authorization_token: r.token } : {}),
    })),
    toolsets: usable.map((r) => ({ type: "mcp_toolset", mcp_server_name: r.name })),
  };
}

/**
 * Enabled servers with a usable bearer token (pasted, or OAuth refreshed as needed).
 * A server whose secret can't be read, or whose sign-in has lapsed, is left out
 * rather than failing the whole turn.
 */
async function enabledServers(userId: string) {
  const rows = await query<Row>("SELECT * FROM mcp_servers WHERE user_id = $1 AND enabled ORDER BY name", [userId]);
  const key = secret();
  const out: { name: string; url: string; token: string | null; expiresAt?: number }[] = [];
  for (const r of rows) {
    if ((r.token || r.oauth) && !key) continue;
    if (r.oauth) {
      try {
        const t = await freshTokens(r.id, r.oauth, key!);
        out.push({ name: r.name, url: r.url, token: t.access_token, expiresAt: t.expires_at });
      } catch (err) {
        console.warn(`MCP server ${r.name}: sign-in needs renewing`, err instanceof Error ? err.message : err);
      }
      continue;
    }
    out.push({ name: r.name, url: r.url, token: r.token ? decrypt(r.token, key!) : null });
  }
  return out;
}

/**
 * The same servers for a background task. Managed Agents takes no tokens in
 * the server list; they go into a vault, matched to each server by URL.
 */
export async function taskMcpParts(userId: string) {
  return enabledServers(userId);
}
