// Tests need a throwaway Postgres database; CI provides one.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres@localhost:5432/jarvis_test";
process.env.JARVIS_APP_TOKEN = "test-token";
process.env.ANTHROPIC_API_KEY ??= "test-key";
