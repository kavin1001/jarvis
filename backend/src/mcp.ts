import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { decrypt, encrypt } from "./crypto.js";
import { query } from "./db.js";

interface Row {
  id: string;
  name: string;
  url: string;
  token: string | null;
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
  return rows.map(({ token, ...r }) => ({ ...r, has_token: token !== null }));
}

export async function addServer(userId: string, input: z.infer<typeof NewServer>) {
  if (input.token && !secret()) throw new Error("Set CONNECTOR_SECRET on the server before adding a token");
  const sealed = input.token ? encrypt(input.token, secret()!) : null;
  const [row] = await query<{ id: string }>(
    `INSERT INTO mcp_servers (user_id, name, url, token) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, name) DO UPDATE SET url = $3, token = $4, enabled = true
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
  const rows = await query<Row>("SELECT * FROM mcp_servers WHERE user_id = $1 AND enabled ORDER BY name", [userId]);
  const key = secret();
  const usable = rows.filter((r) => r.token === null || key !== null);
  return {
    servers: usable.map((r) => ({
      type: "url",
      name: r.name,
      url: r.url,
      ...(r.token ? { authorization_token: decrypt(r.token, key!) } : {}),
    })),
    toolsets: usable.map((r) => ({ type: "mcp_toolset", mcp_server_name: r.name })),
  };
}
