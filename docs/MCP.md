# Connecting other apps with MCP servers

Jarvis can use tools from any remote MCP server (Model Context Protocol) that is reachable over https. Claude connects to the server itself through the Messages API's MCP connector, so the server never talks to your phone.

## Add a server

In the app, go to **Settings**, then **Connected apps**, then **Add a server**:

- **Name**: a short lowercase id, like `github` or `zapier`. Claude sees it as the toolset's name.
- **URL**: the server's https endpoint. Streamable HTTP and SSE both work.
- **Access token** (optional): sent as `Authorization: Bearer …`. It is encrypted with `CONNECTOR_SECRET` and the app never shows it again.

Use the switch to turn a server off without deleting it.

## What works

- Servers that accept a bearer token or carry the key in their URL. Examples are GitHub's remote MCP server with a fine-grained personal access token, or a Zapier or Pipedream MCP URL.
- Tools only. MCP resources and prompts aren't supported by the connector.

## What doesn't (yet)

- Servers that require a full browser OAuth sign-in, such as some official Notion or Linear servers. Jarvis doesn't run that OAuth flow yet. Use a server that takes an API token, or paste a token you got elsewhere.
- Local (stdio) servers on your computer.

## Safety

- Anything a tool returns is treated as data, not instructions.
- The system prompt tells Claude to confirm before changing or sending anything.
- Prefer read-only or narrowly scoped tokens.
- If you remove a server that a conversation already used, start a new chat if replies start failing.
