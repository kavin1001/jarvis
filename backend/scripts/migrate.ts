import { readFileSync } from "node:fs";
import { pool } from "../src/db.js";

await pool.query(readFileSync("./schema.sql", "utf8"));
console.log("Schema applied.");
await pool.end();
