import pg from "pg";
import { config } from "./config.js";

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  // Fail a request after 10 seconds instead of hanging while the database is unreachable.
  connectionTimeoutMillis: 10_000,
});

// An idle connection dropping (the database restarting for maintenance, say) emits "error".
// Without a listener that would stop the process; the pool replaces the connection by itself.
pool.on("error", (err) => console.error("database connection lost", err.message));

export async function query<T extends pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await pool.query<T>(text, params);
  return result.rows;
}
