function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

export const config = {
  databaseUrl: required("DATABASE_URL"),
  appToken: required("JARVIS_APP_TOKEN"),
  fastModel: process.env.FAST_MODEL ?? "claude-opus-5-5",
  fastEffort: (process.env.FAST_EFFORT ?? "low") as "low" | "medium" | "high",
  taskAgentId: process.env.TASK_AGENT_ID,
  taskEnvironmentId: process.env.TASK_ENVIRONMENT_ID,
  taskVaultId: process.env.TASK_VAULT_ID,
  approvalTimeoutMs: Number(process.env.APPROVAL_TIMEOUT_MINUTES ?? 30) * 60_000,
  port: Number(process.env.PORT ?? 8787),
  // Single-user MVP: every request belongs to this user.
  userId: "me",
};
