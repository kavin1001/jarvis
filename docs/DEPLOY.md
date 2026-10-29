# Deploying Jarvis

This gets the backend online and the app onto your phone. Steps marked **(costs money)** or **(account)** are yours to do; everything else is in the repo.

## 1. Claude API key (account, costs money)

1. Sign in at [platform.claude.com](https://platform.claude.com) and create an API key.
2. Set a monthly spend limit in the Console. `DAILY_BUDGET_USD` in the backend is a second, per-day guard.

## 2. Backend on Render (account, costs money)

The repo has a Render Blueprint (`render.yaml`) that creates the web service and a Postgres database.

1. In Render: **New → Blueprint**, pick `kavin1001/jarvis`.
2. When prompted, paste `ANTHROPIC_API_KEY`. Leave the `TASK_*` values empty for now.
3. Render generates `JARVIS_APP_TOKEN`; copy it from the service's Environment tab, since the app needs it.
4. After the deploy, open `https://<your-service>.onrender.com/health`. It should return `{"ok":true}`.

The schema is applied automatically on every boot. Check plan names and prices on Render before creating; the blueprint asks for a small paid web service and database because free instances sleep, which would delay reminders and background tasks.

Any host that runs a Docker image works the same way (Fly.io, Railway, a VPS): build `backend/Dockerfile` and set the variables from `backend/.env.example`.

## Try it in a browser first (free, no Apple account)

The backend image also serves the web version of the app. Once Render is up, open your backend URL (e.g. `https://jarvis-backend.onrender.com`) in Safari or Chrome and enter `JARVIS_APP_TOKEN`. On an iPhone, tap Share, then **Add to Home Screen**, for an app icon. It then opens full screen, with its own icon, like an installed app. On Android, Chrome offers **Install app**; once installed, Jarvis appears in the share sheet, so you can share a link or text to it and ask about it.

The web version does chat, photos, history, memory, tasks, connectors and settings. Voice input works in Chrome and Safari through the browser's speech recognition, and answers are read aloud. What it can't do: push notifications (open the Tasks tab instead), Siri and Shortcuts links, and secure storage (the device token is kept in the browser's local storage, so use it only on your own devices).

## 3. Background task agent (costs money per task)

From your computer, with the API key in `backend/.env`:

```bash
cd backend
npm install
TASK_ALLOWED_HOSTS=opentable.com,amazon.com node --env-file=.env node_modules/.bin/tsx scripts/setup-agent.ts
```

Paste the printed `TASK_AGENT_ID` and `TASK_ENVIRONMENT_ID` into Render's environment and redeploy. See the README for the trade-off of `--unrestricted` networking.

For website logins, create a vault in the Console, add each login as an environment-variable credential limited to that site's hosts, and set `TASK_VAULT_ID`.

## 4. App on your iPhone (account, costs money)

You need an [Apple Developer account](https://developer.apple.com/programs/) for TestFlight and push notifications, and a free [Expo](https://expo.dev) account.

```bash
cd app
npm install
npx eas login
npx eas init                       # links the project and adds the projectId push needs
npx eas build --profile preview --platform ios
```

EAS walks you through certificates and push keys. Install the build from the link it prints (or use `--profile production` and `npx eas submit` for TestFlight). On first launch, enter your backend URL and `JARVIS_APP_TOKEN`. The app swaps it for its own device token and doesn't keep the master. To add another phone or iPad, tap **Settings**, then **Pair another device**, and enter that code on the new device.

For day-to-day development: `npx eas build --profile development --platform ios` once, then `npx expo start` and open the dev build.

## 5. Gmail and Google Calendar (optional, free Google Cloud account)

Lets Jarvis search and read your mail, save drafts (it never sends), and read or add calendar events.

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project and enable the **Gmail API** and **Google Calendar API**.
2. Under **Google Auth Platform**, set up the consent screen as **External**, leave it in **Testing**, and add your own Gmail address as a test user. Add the scopes `gmail.readonly`, `gmail.compose`, `gmail.modify` and `calendar.events`. (`gmail.modify` lets Jarvis archive and mark email. It can't delete mail permanently.)
3. Create an **OAuth client ID** of type **Web application** with the authorized redirect URI `https://<your-backend>/oauth/google/callback`.
4. In Render, set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `PUBLIC_URL` (your backend's https URL, no trailing path). `CONNECTOR_SECRET` is generated for you; changing it later disconnects Google.
5. In the app: Settings, Connect Google.

Testing-mode apps get refresh tokens that Google expires after 7 days, so you'll reconnect weekly until the app is verified. That's fine for personal use.

## Checklist

- [ ] API key + Console spend limit
- [ ] Render blueprint deployed, `/health` OK
- [ ] `JARVIS_APP_TOKEN` saved somewhere safe
- [ ] Task agent created, IDs set (optional)
- [ ] Vault with logins (optional)
- [ ] Apple Developer + Expo accounts, `eas init`, first build installed
- [ ] Google OAuth client, env vars set, Google connected in the app (optional)
