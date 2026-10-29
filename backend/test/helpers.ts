import { readFileSync } from "node:fs";
import { pool } from "../src/db.js";

export async function resetDb() {
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await pool.query(readFileSync("./schema.sql", "utf8"));
}

export const auth = { Authorization: "Bearer test-token" };
