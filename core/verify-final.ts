import { chromium } from "playwright";
const BASE = "https://browserpilot.msantoki.com";
const b = await chromium.launch({ headless: true });
const page = await b.newPage();

await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
await page.fill("#email", "manansantoki2003@gmail.com");
await page.fill("#password", "browserpilot-dev-2026");
await page.click("button[type=submit]");
await page.waitForURL(u => u.pathname === "/", { timeout: 40000 });

await page.goto(`${BASE}/files`, { waitUntil: "domcontentloaded" });
console.log("1. Files page:", await page.textContent("h1"));

// Start a session, say something, reload, and check the message survived.
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.selectOption("select[name=siteProfileId]", { label: "JWM ERP" });
await page.fill("input[name=title]", "persistence check");
await page.click("button:has-text('New session')");
await page.waitForURL(u => u.pathname.startsWith("/sessions/"), { timeout: 120000 });
const url = page.url();
await page.waitForTimeout(9000);

await page.locator("input[placeholder*='Tell the robot']").fill("What page are you on? Look only.");
await page.keyboard.press("Enter");
await page.waitForTimeout(20000);

await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(4000);
const body = await page.textContent("body");
console.log("2. my message survived reload:", body?.includes("What page are you on?"));
console.log("3. agent reply survived reload:", /dashboard/i.test(body ?? ""));

await page.click("button:has-text('Stop session')");
await page.waitForTimeout(5000);
await page.goto(url, { waitUntil: "domcontentloaded" });
const after = await page.textContent("body");
console.log("4. transcript visible after session ended:", after?.includes("What page are you on?"));
await b.close();
