import { pool } from "../src/db.js";
import { migrate } from "../src/migrate.js";

await migrate();
console.log("Schema applied.");
await pool.end();
