# Jarvis

Personal voice and text assistant: Expo app (`app/`) and a TypeScript backend (`backend/`) that calls the Claude API (fast lane) and Claude Managed Agents (task lane). See `README.md` for the architecture and `docs/ROADMAP.md` for what is planned.

## Conventions

- Backend: Hono, `pg`, `@anthropic-ai/sdk`, ESM with `.js` import suffixes. Validate request bodies and tool inputs with zod.
- Conversation history sent to Claude must stay append-only: store each turn's full content blocks and never edit past turns. Out-of-band updates (task results, reminders) are stored as `kind = 'task_update'` and folded into the next user turn.
- App: Expo SDK 58. Install native modules at the versions in `node_modules/expo/bundledNativeModules.json` (`npx expo install` may be blocked by network policy in cloud sessions).
- Before committing: `npm run typecheck` in both packages, and `npm test` in `backend/` (needs `TEST_DATABASE_URL`).
- Record user-facing changes in `CHANGELOG.md`.
