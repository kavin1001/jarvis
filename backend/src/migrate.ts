import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { pool } from "./db.js";

const schemaPath = fileURLToPath(new URL("../schema.sql", import.meta.url));

/** Applies schema.sql. Every statement is idempotent, so this runs on each boot. */
export async function migrate() {
  await pool.query(readFileSync(schemaPath, "utf8"));
}
