# Changelog

Newest first. Each entry matches a merged pull request.

## Unreleased

- App: tab bar with History (switch or delete conversations), Tasks (status, results, tap-to-approve, live polling), Memory (see, add and forget facts) and Settings (disconnect). A badge shows approvals waiting on you.
- Backend: `POST /api/facts`, `DELETE /api/conversations/:id`.
- CI: the app's iOS bundle is built on every PR.
- Background tasks survive backend restarts: on boot the server replays each running session's events, picks up approval requests it missed, and finishes tasks that ended while it was down. Approvals go straight to the agent's session, and unanswered ones are denied after `APPROVAL_TIMEOUT_MINUTES`.
- Backend tests (vitest + Postgres): memory, the chat turn loop with a fake Claude client, and HTTP auth and validation. Run in CI.
- CI: type-check backend and app on every push and pull request.
- Docs: roadmap and contributor notes.

## 0.1.0, 2026-10-29

- First scaffold: Expo app with chat, hold-to-talk voice, push and approvals; backend fast lane (streaming Claude API with web search, web fetch and memory tools); Managed Agents task lane with approval gates; Postgres memory.
