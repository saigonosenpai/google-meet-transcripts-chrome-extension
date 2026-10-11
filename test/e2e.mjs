// End-to-end test: loads the extension in Chromium, serves a fake Meet call, and fakes
// Google's OAuth + Drive endpoints, then checks the transcript and the Google Doc upload.
//   node test/e2e.mjs <extension dir> <screenshot dir>
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import assert from "node:assert/strict";

// Lets context.route() see the extension service worker's requests to Google Drive.
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = "1";
const { chromium } = await import("playwright");

// Test a copy of the extension with a client ID built into config.js, as a real build would have.
const src = path.resolve(process.argv[2] || ".");
const ext = fs.mkdtempSync(path.join(os.tmpdir(), "meet-transcripts-"));
fs.cpSync(src, ext, { recursive: true, filter: (p) => !/(\.git|node_modules|test)$/.test(p) });
fs.writeFileSync(path.join(ext, "config.js"), 'const GOOGLE_CLIENT_ID = "test.apps.googleusercontent.com";\n');
const shots = process.argv[3] || ".";
const mock = fs.readFileSync(new URL("./mock-meet.html", import.meta.url), "utf8");
const ctx = await chromium.launchPersistentContext("", {
  headless: true, channel: "chromium",
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
await ctx.route("https://meet.google.com/**", (r) => r.fulfill({ contentType: "text/html", body: mock }));

// --- fake Google -------------------------------------------------------------------------
const drive = [];
let docVersion = 0;
await ctx.route("https://www.googleapis.com/**", async (r) => {
  const req = r.request();
  const u = new URL(req.url());
  drive.push({ method: req.method(), path: u.pathname, auth: req.headers().authorization, body: req.postData() || "" });
  const json = (o) => r.fulfill({ contentType: "application/json", body: JSON.stringify(o) });
  if (u.pathname === "/drive/v3/about") return json({ user: { emailAddress: "sam@example.com" } });
  if (u.pathname === "/drive/v3/files" && req.method() === "POST") return json({ id: "folder1" });
  if (u.pathname.startsWith("/drive/v3/files/")) return json({ id: "folder1", trashed: false });
  if (u.pathname.startsWith("/upload/")) {
    docVersion++;
    return json({ id: "doc1", webViewLink: "https://docs.google.com/document/d/doc1/edit", trashed: false });
  }
  r.fulfill({ status: 404, body: "{}" });
});

let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent("serviceworker");
const id = new URL(sw.url()).host;
// The sign-in window isn't routed through Playwright, so finish it by hand the way Google
// does after the user approves: redirect to the extension's chromiumapp.org URL with a token.
ctx.on("page", async (p) => {
  await p.waitForURL(/accounts\.google\.com/, { timeout: 5000 }).catch(() => {});
  if (!/accounts\.google\.com/.test(p.url())) return;
  const redirect = `https://${new URL(sw.url()).host}.chromiumapp.org/`;
  await p.goto(redirect + "#access_token=TEST_TOKEN&expires_in=3600").catch(() => {});
});

console.log("extension id:", id);
await sw.evaluate(() => chrome.storage.local.set({ settings: { myName: "Sam" } }));

// --- sign in through the popup ----------------------------------------------------------
const popup = await ctx.newPage();
await popup.setViewportSize({ width: 340, height: 700 });
await popup.goto(`chrome-extension://${id}/popup.html`);
assert.equal(await popup.inputValue("#redirect"), `https://${id}.chromiumapp.org/`);
await popup.screenshot({ path: shots + "/popup-signed-out.png" });
await popup.click("#connect");
assert.ok(await popup.isHidden("#setup"), "no developer setup when the client ID is built in");
assert.ok(await popup.isHidden("#account"));
await popup.waitForSelector("#driveState.ok", { timeout: 15000 });
assert.equal(await popup.textContent("#accountEmail"), "Signed in as sam@example.com");
assert.ok(await popup.isHidden("#connect"));
console.log("popup:", await popup.textContent("#driveMsg"));
await popup.screenshot({ path: shots + "/popup.png" });
await popup.close();

// --- the call ---------------------------------------------------------------------------------
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
assert.deepEqual(meta.speakers, ["Alice", "Sam", "Bob"]);
assert.ok(!drive.some((d) => d.path.startsWith("/upload/")), "nothing uploaded mid-call");

// Leave the call -> Doc is created.
await page.evaluate(() => window.leave());
await page.waitForFunction(() => true);
for (let i = 0; i < 40 && !drive.some((d) => d.path.startsWith("/upload/")); i++) await page.waitForTimeout(250);
await page.waitForTimeout(500);
const upload = drive.find((d) => d.path.startsWith("/upload/"));
console.log("drive state:", JSON.stringify((await sw.evaluate(() => chrome.storage.local.get(null)))["d:" + meta.id]), drive.length);
assert.ok(upload, "Doc uploaded after leaving");
assert.equal(upload.method, "POST");
assert.equal(upload.auth, "Bearer TEST_TOKEN");
const metaJson = JSON.parse(upload.body.split("\r\n\r\n")[1].split("\r\n")[0]);
console.log("doc metadata:", JSON.stringify(metaJson));
const today = new Date(); const pad = (n) => String(n).padStart(2, "0");
assert.equal(metaJson.name, `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())} - Weekly sync - Alice, Bob, Carol, Sam`);
assert.equal(metaJson.mimeType, "application/vnd.google-apps.document");
assert.deepEqual(metaJson.parents, ["folder1"]);
assert.ok(drive.some((d) => d.path === "/drive/v3/files" && d.body.includes('"Meet Transcripts"')), "folder created");
const html = upload.body.split("text/html; charset=UTF-8\r\n\r\n")[1];
fs.writeFileSync(shots + "/doc.html", html);
for (const s of ["Weekly sync", "Speaking time", "Possible action items", "Can you send the deck by Thursday?",
                 "Possible decisions", "We agreed to go with option B.", "Great, thanks everyone."]) assert.ok(html.includes(s), s);
data = await sw.evaluate(() => chrome.storage.local.get(null));
assert.equal(data["d:" + meta.id].fileId, "doc1");

// --- viewer: manual update reuses the same Doc ------------------------------------------------
const v = await ctx.newPage();
await v.setViewportSize({ width: 1200, height: 900 });
await v.goto(`chrome-extension://${id}/viewer.html#` + encodeURIComponent(meta.id));
await v.waitForSelector(".drive a");
await v.click("#title");
await v.keyboard.press("End");
await v.keyboard.type(" (Q4)");
await v.keyboard.press("Enter");
await v.waitForTimeout(300);
await v.click("#syncNow");
await v.waitForSelector("#syncNow:not([disabled])");
const patch = drive.filter((d) => d.path.startsWith("/upload/")).pop();
assert.equal(patch.method, "PATCH");
assert.ok(patch.path.endsWith("/doc1"));
console.log("renamed doc:", JSON.parse(patch.body.split("\r\n\r\n")[1].split("\r\n")[0]).name);
await v.screenshot({ path: shots + "/viewer.png" });

console.log("Drive calls:", drive.map((d) => d.method + " " + d.path).join(", "));
console.log("ALL CHECKS PASSED");
await ctx.close();
