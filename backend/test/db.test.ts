import { afterAll, describe, expect, it } from "vitest";
import { pool, query } from "../src/db.js";

afterAll(() => pool.end());

describe("database pool", () => {
  it("survives a dropped idle connection", async () => {
    expect(() => pool.emit("error", new Error("terminating connection due to administrator command"))).not.toThrow();
    expect(await query<{ ok: number }>("SELECT 1 AS ok")).toEqual([{ ok: 1 }]);
  });
});
