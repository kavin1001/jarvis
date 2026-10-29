# Connecting other apps with MCP servers

Jarvis can use tools from any remote MCP server (Model Context Protocol) that is reachable over https. Claude connects to the server itself through the Messages API's MCP connector, so the server never talks to your phone.

## Add a server

In the app, go to **Settings**, then **Connected apps**, then **Add a server**:

- **Name**: a short lowercase id, like `github` or `zapier`. Claude sees it as the toolset's name.
- **URL**: the server's https endpoint. Streamable HTTP and SSE both work.
- **Access token** (optional): sent as `Authorization: Bearer …`. It is encrypted with `CONNECTOR_SECRET` and the app never shows it again.

Use the switch to turn a server off without deleting it.

## Signing in (OAuth)

Hosted servers such as Notion's (`https://mcp.notion.com/mcp`) or Linear's (`https://mcp.linear.app/mcp`) don't take a pasted token. Add them with no token, and Jarvis opens the server's sign-in page in your browser. After you approve, the page says "Connected" and the server shows **signed in** in Settings. If a sign-in lapses, tap **Sign in again**.

This needs `PUBLIC_URL` (your backend's address, which the sign-in page returns to) and `CONNECTOR_SECRET` set on the server. Jarvis registers itself with the server automatically (dynamic client registration), so there's no client ID to create. Tokens are encrypted, refreshed before they expire, and never sent to the app.

Background tasks get the current access token for the length of the task, without the refresh token.

## What works

- Servers that accept a bearer token or carry the key in their URL. Examples are GitHub's remote MCP server with a fine-grained personal access token, or a Zapier or Pipedream MCP URL.
- Tools only. MCP resources and prompts aren't supported by the connector.

## Background tasks

Tasks Jarvis runs in the background get the same enabled servers, for that task only. Every call to one of their tools waits for your OK, as a notification you approve or deny.

A server's token is put in a vault Jarvis creates for that one task, so it never appears in the task's configuration or sandbox. The vault is deleted when the task ends. If the task agent already has a server with the same name, the agent's own one is used.

The task sandbox has to be allowed to reach MCP servers. `scripts/setup-agent.ts` turns this on (`allow_mcp_servers`), so you don't need to list their hosts.

## What doesn't (yet)

- Local (stdio) servers on your computer.

## Safety

- Anything a tool returns is treated as data, not instructions.
- The system prompt tells Claude to confirm before changing or sending anything.
- Prefer read-only or narrowly scoped tokens.
- If you remove a server that a conversation already used, start a new chat if replies start failing.
