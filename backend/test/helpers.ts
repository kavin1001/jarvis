import { readFileSync } from "node:fs";
import { pool } from "../src/db.js";

export async function resetDb() {
  // Work a previous test started in the background (titling a chat, say) can still be
  // writing; dropping the schema then deadlocks with it, so try again after a moment.
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
      break;
    } catch (err) {
      if ((err as { code?: string }).code !== "40P01" || attempt === 5) throw err;
      await new Promise((r) => setTimeout(r, 50 * attempt));
    }
  }
  await pool.query(readFileSync("./schema.sql", "utf8"));
}

export const auth = { Authorization: "Bearer test-token" };
