// Smoke test of the web app against a running backend: signs in, opens every tab, and uses the
// parts that don't need Claude (lists, notes, settings). Fails on any page error.
//   JARVIS_URL=http://localhost:8799 JARVIS_APP_TOKEN=... node smoke.mjs
import { chromium } from "playwright";

const url = process.env.JARVIS_URL ?? "http://localhost:8799";
const token = process.env.JARVIS_APP_TOKEN;
if (!token) throw new Error("Set JARVIS_APP_TOKEN");

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("dialog", (d) => (d.type() === "confirm" ? d.accept() : d.dismiss()));

let failed = false;
async function step(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed = true;
    console.log(`FAIL ${name}: ${err.message.split("\n")[0]}`);
    await page.screenshot({ path: `smoke-failure-${name.replace(/\W+/g, "-")}.png` }).catch(() => {});
  }
}
const tab = (name) => page.getByText(name, { exact: true }).last().click();
const see = (text, opts = {}) => page.getByText(text, opts).first().waitFor({ timeout: 10_000 });

await step("sign in", async () => {
  await page.goto(url);
  await page.locator("input").nth(1).waitFor();
  await page.locator("input").nth(1).fill(token);
  await page.getByText("Connect", { exact: true }).last().click();
  await see("Settings", { exact: true });
});

await step("history", async () => {
  await tab("History");
  await page.waitForTimeout(500);
});

await step("lists: add and tick an item", async () => {
  await tab("Lists");
  await page.getByText("+ New list", { exact: true }).click();
  await page.getByPlaceholder("Name it, e.g. Packing").fill("Smoke");
  await page.getByText("Create", { exact: true }).click();
  await page.getByPlaceholder("Add to smoke").fill("milk, eggs");
  await page.getByText("Add", { exact: true }).click();
  await see("eggs", { exact: true });
  await page.getByRole("checkbox", { name: "milk" }).click();
  await see("Clear 1 checked");
});

await step("notes: write and find one", async () => {
  await page.getByText("📝 Notes").click();
  await page.getByText("+ New", { exact: true }).click();
  await page.getByPlaceholder("Write your note").fill("Smoke test note: the gate code is 4821");
  await page.getByText("Save", { exact: true }).click();
  await see("‹ Notes");
  await page.getByText("‹ Notes").click();
  await page.getByPlaceholder("Search notes").fill("gate code");
  await see("Smoke test note: the gate code is 4821", { exact: true });
});

await step("tasks", async () => {
  await tab("Tasks");
  await see("Tasks and reminders");
});

await step("memory", async () => {
  await tab("Memory");
  await page.waitForTimeout(500);
});

await step("settings", async () => {
  await tab("Settings");
  for (const heading of ["Usage", "How Jarvis replies", "Privacy", "Keep chats", "What Jarvis did on your accounts", "Signed-in devices"]) await see(heading);
});

await step("no page errors", async () => {
  if (errors.length) throw new Error(errors.join(" | "));
});

await browser.close();
process.exit(failed ? 1 : 0);
