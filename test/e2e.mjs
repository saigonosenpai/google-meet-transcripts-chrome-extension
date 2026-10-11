// End-to-end test: loads the extension in Chromium, serves a fake Meet call, and checks
// the stored transcript and the .docx file it saves to Downloads/Meet Transcripts.
//   node test/e2e.mjs <extension dir> <screenshot dir>
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";

import { chromium } from "playwright";

const ext = path.resolve(process.argv[2] || ".");
const shots = process.argv[3] || ".";
const mock = fs.readFileSync(new URL("./mock-meet.html", import.meta.url), "utf8");
// Launch Chromium ourselves and attach over CDP: Playwright's own launch intercepts
// downloads and renames them, and we want to see the files exactly as Chrome saves them.
async function launch({ askWhereToSave = false } = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "mt-profile-"));
  const downloads = fs.mkdtempSync(path.join(os.tmpdir(), "mt-downloads-"));
  fs.mkdirSync(path.join(profile, "Default"));
  fs.writeFileSync(path.join(profile, "Default", "Preferences"),
    JSON.stringify({ download: { default_directory: downloads, prompt_for_download: askWhereToSave } }));
  const port = 9300 + Math.floor(Math.random() * 500);
  const proc = spawn(chromium.executablePath(), [
    "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run",
    ...(process.getuid && process.getuid() === 0 ? ["--no-sandbox"] : []), // containers run as root
    `--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "about:blank",
  ], { stdio: "ignore" });
  let browser;
  for (let i = 0; i < 50 && !browser; i++) {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => null);
    if (!browser) await new Promise((r) => setTimeout(r, 200));
  }
  // Playwright redirects downloads to GUID-named files even when attached; restore Chrome's own behavior.
  await (await browser.newBrowserCDPSession()).send("Browser.setDownloadBehavior", { behavior: "default" });
  return { browser, ctx: browser.contexts()[0], downloads, close: async () => { await browser.close(); proc.kill(); } };
}

const { ctx, downloads, close } = await launch();
await ctx.route("https://meet.google.com/**", (r) => r.fulfill({ contentType: "text/html", body: mock }));

// The extension ID follows from the manifest key; any extension page can read its storage.
const key = Buffer.from(JSON.parse(fs.readFileSync(path.join(ext, "manifest.json"))).key, "base64");
const id = [...createHash("sha256").update(key).digest("hex").slice(0, 32)]
  .map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
const sw = await ctx.newPage();
await sw.goto(`chrome-extension://${id}/viewer.html`);
const today = new Date(); const pad = (n) => String(n).padStart(2, "0");
const date = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
const dayDir = path.join(downloads, "Meet Transcripts", date);
const fileOf = (mid) => sw.evaluate((k) => chrome.storage.local.get(k).then((d) => d[k]), "f:" + mid);

// --- a scheduled call ("Weekly sync") ---------------------------------------------------------
// No name configured: "You" in captions must become the Google account name, "Sam Lee".
const page = await ctx.newPage();
await page.goto("https://meet.google.com/abc-defg-hij");
await page.waitForFunction(() => window.done, null, { timeout: 30000 });
await page.waitForTimeout(2500);
let data = await sw.evaluate(() => chrome.storage.local.get(null));
const meta = Object.values(data.meetings)[0];
const t = data["t:" + meta.id];
console.log("meeting:", JSON.stringify({ title: meta.title, participants: meta.participants, speakers: meta.speakers }));
const bob = t.filter((e) => e.speaker === "Bob").map((e) => e.text).join(" ");
for (let i = 1; i <= 30; i++) assert.equal(bob.split(`Sentence number ${i} `).length, 2, `sentence ${i} once`);
assert.deepEqual(meta.speakers, ["Alice", "Sam Lee", "Bob"]);
assert.equal(meta.title, "Weekly sync");
assert.equal(data["f:" + meta.id], undefined, "nothing saved mid-call");

// Leave the call -> the .docx is saved.
await page.evaluate(() => window.leave());
const fileState = () => fileOf(meta.id);
let file;
for (let i = 0; i < 40 && !(file = await fileState()); i++) await page.waitForTimeout(250);
assert.ok(file && !file.error, "saved after leaving: " + JSON.stringify(file));
const expected = `${date} - Weekly sync - Alice, Bob, Carol, Sam Lee.docx`;
console.log("saved:", file.filename);
assert.equal(path.basename(file.filename), expected);
assert.equal(path.dirname(file.filename), dayDir, "grouped in a folder per day");
assert.ok(fs.existsSync(file.filename));
fs.copyFileSync(file.filename, shots + "/saved.docx");

// --- viewer: rename, save again -> one file, new name -----------------------------------------
const v = await ctx.newPage();
await v.setViewportSize({ width: 1200, height: 900 });
await v.goto(`chrome-extension://${id}/viewer.html#` + encodeURIComponent(meta.id));
await v.waitForSelector("#showFile");
await v.click("#title");
await v.keyboard.press("End");
await v.keyboard.type(" (Q4)");
await v.keyboard.press("Enter");
await v.waitForTimeout(300);
await v.click("#saveNow");
await v.waitForFunction(() => document.querySelector("#file").textContent.includes("(Q4)"));
const renamed = await fileState();
console.log("renamed:", path.basename(renamed.filename));
assert.ok(path.basename(renamed.filename).includes("Weekly sync (Q4) - Alice"));
assert.ok(fs.existsSync(renamed.filename), "new file exists");
assert.ok(!fs.existsSync(file.filename), "old file removed");
assert.deepEqual(fs.readdirSync(path.dirname(renamed.filename)), [path.basename(renamed.filename)]);
await v.screenshot({ path: shots + "/viewer.png" });

const p = await ctx.newPage();
await p.setViewportSize({ width: 340, height: 600 });
await p.goto(`chrome-extension://${id}/popup.html`);
await p.waitForTimeout(500);
assert.ok((await p.textContent("#lastSaved")).includes("(Q4)"));
await p.screenshot({ path: shots + "/popup.png" });

// --- spontaneous calls: named after who else joined ---------------------------------------------
async function runCall(code) {
  const pg = await ctx.newPage();
  await pg.goto("https://meet.google.com/" + code);
  await pg.waitForFunction(() => window.done, null, { timeout: 30000 });
  await pg.waitForTimeout(2000);
  await pg.evaluate(() => window.leave());
  const { meetings } = await sw.evaluate(() => chrome.storage.local.get("meetings"));
  const m = Object.values(meetings).find((x) => x.code === code);
  let f;
  for (let i = 0; i < 40 && !(f = await fileOf(m.id)); i++) await pg.waitForTimeout(250);
  await pg.close();
  return { m, f };
}
const call1 = await runCall("xtk-wiod-gkq");
console.log("spontaneous:", call1.m.title, "->", path.basename(call1.f.filename));
assert.equal(call1.m.title, "Call with Alice, Bob, Carol");
assert.equal(call1.f.filename, path.join(dayDir, `${date} - Call with Alice, Bob, Carol.docx`));
// Same people again the same day: a second file, not an overwrite.
const call2 = await runCall("pqr-stuv-wxy");
console.log("second call, same people:", path.basename(call2.f.filename));
assert.equal(call2.f.filename, path.join(dayDir, `${date} - Call with Alice, Bob, Carol (2).docx`));
assert.equal(fs.readdirSync(dayDir).length, 3);

// Recordings from before this version stored "Meet <code>" for untitled calls.
assert.equal(await sw.evaluate(() => MT.title({ title: "Meet xtk-wiod-gkq", speakers: ["You"] })), "Solo call");
assert.equal(await sw.evaluate(() => MT.title({ title: "Meet xtk-wiod-gkq", speakers: ["Ann", "You"] })), "Call with Ann");
assert.equal(await sw.evaluate(() => MT.title({ title: "Weekly sync", speakers: ["Ann"] })), "Weekly sync");

await v.goto(`chrome-extension://${id}/viewer.html#` + encodeURIComponent(call1.m.id));
await v.waitForSelector("#showFile");
await v.screenshot({ path: shots + "/viewer-list.png" });

await close();

// --- Chrome set to "Ask where to save each file": a clear warning, not a silent failure ----
{
  const run = await launch({ askWhereToSave: true });
  const v = await run.ctx.newPage();
  await v.goto(`chrome-extension://${id}/viewer.html`);
  await v.evaluate((m) => chrome.storage.local.set({ meetings: { [m.id]: m }, ["t:" + m.id]: [{ speaker: "Ann", text: "Hello.", ts: m.startedAt }] }),
    { id: "x-1", code: "abc-defg-hij", title: "Ask test", startedAt: Date.now(), endedAt: Date.now(), speakers: ["Ann"] });
  await v.goto(`chrome-extension://${id}/viewer.html#x-1`);
  await v.click("#saveNow");
  await v.waitForSelector("#dlSettings", { timeout: 15000 });
  console.log("ask-where-to-save warning:", (await v.textContent("#file .err")).slice(0, 70) + "…");
  const p = await run.ctx.newPage();
  await p.goto(`chrome-extension://${id}/popup.html`);
  await p.waitForSelector("#askWarning:not([hidden])");
  await run.close();
}

console.log("ALL CHECKS PASSED");
