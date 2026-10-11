import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs";
const ext = path.resolve(process.argv[2]);
const mock = fs.readFileSync(new URL("./mock-meet.html", import.meta.url), "utf8");
const ctx = await chromium.launchPersistentContext("", {
  headless: true, channel: "chromium",
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
await ctx.route("https://meet.google.com/**", (r) => r.fulfill({ contentType: "text/html", body: mock }));
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent("serviceworker");
const id = new URL(sw.url()).host;
await sw.evaluate(() => chrome.storage.local.set({ settings: { myName: "Sam" } }));

const page = await ctx.newPage();
page.on("console", (m) => console.log("[page]", m.text()));
await page.goto("https://meet.google.com/abc-defg-hij");
await page.waitForFunction(() => window.done, null, { timeout: 30000 });
await page.waitForTimeout(2500);
const data = await sw.evaluate(() => chrome.storage.local.get(null));
const meta = Object.values(data.meetings)[0];
const t = data["t:" + meta.id];
console.log("META", JSON.stringify(meta));
for (const e of t) console.log(`  ${e.speaker}: ${e.text}`);
const bob = t.filter((e) => e.speaker === "Bob").map((e) => e.text).join(" ");
const missing = [];
for (let i = 1; i <= 30; i++) if (!bob.includes(`Sentence number ${i} `)) missing.push(i);
const dupes = [];
for (let i = 1; i <= 30; i++) if (bob.split(`Sentence number ${i} `).length > 2) dupes.push(i);
console.log("bob missing:", missing, "dupes:", dupes, "bob entries:", t.filter((e) => e.speaker === "Bob").length);

const v = await ctx.newPage();
await v.setViewportSize({ width: 1200, height: 900 });
await v.goto(`chrome-extension://${id}/viewer.html#` + encodeURIComponent(meta.id));
await v.waitForSelector(".turn");
await v.screenshot({ path: process.argv[3] + "/viewer.png" });
await v.click('[data-filter="actions"]');
console.log("ACTIONS:", await v.$$eval(".turn p", (ps) => ps.map((p) => p.textContent)));
await v.click('[data-filter="decisions"]');
console.log("DECISIONS:", await v.$$eval(".turn p", (ps) => ps.map((p) => p.textContent)));
const p = await ctx.newPage();
await p.setViewportSize({ width: 340, height: 420 });
await p.goto(`chrome-extension://${id}/popup.html`);
await p.waitForTimeout(500);
await p.screenshot({ path: process.argv[3] + "/popup.png" });
await ctx.close();
