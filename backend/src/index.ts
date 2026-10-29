import { serve } from "@hono/node-server";
import { app } from "./app.js";
import { config } from "./config.js";
import { expireApprovals, resumeTasks, taskLaneConfigured } from "./tasks.js";

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Jarvis backend listening on http://localhost:${info.port}`);
});

if (taskLaneConfigured()) {
  resumeTasks().then(
    (n) => n > 0 && console.log(`Resumed ${n} background task(s)`),
    (err) => console.error("could not resume tasks", err),
  );
  setInterval(() => expireApprovals().catch((err) => console.error("approval sweep failed", err)), 60_000);
}
