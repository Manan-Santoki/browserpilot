import { chromium } from "playwright";
const BASE = "https://browserpilot.msantoki.com";
const b = await chromium.launch({ headless: true });
const page = await b.newPage();
const errs: string[] = [];
page.on("console", m => { if (m.type() === "error") errs.push(m.text().slice(0, 100)); });

await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
await page.fill("#email", "manansantoki2003@gmail.com");
await page.fill("#password", "browserpilot-dev-2026");
await page.click("button[type=submit]");
await page.waitForTimeout(8000);
console.log("1. after login:", page.url());
const c = (await page.context().cookies()).find(x => x.name === "bp_session");
console.log("2. cookie:", c ? `stored (secure=${c.secure})` : "NOT STORED");

if (page.url().endsWith(".com/")) {
  await page.selectOption("select[name=siteProfileId]", { label: "JWM ERP" });
  await page.fill("input[name=title]", "https wss test");
  await page.click("button:has-text('New session')");
  await page.waitForURL(u => u.pathname.startsWith("/sessions/"), { timeout: 120000 }).catch(()=>{});
  console.log("3. session:", page.url());
  await page.waitForTimeout(9000);
  console.log("4. wss connected:", !(await page.locator("input[placeholder*='Tell the robot']").isDisabled()));
  await page.click("text=Live preview");
  await page.waitForTimeout(8000);
  console.log("5. live frame over wss:", await page.locator("img[alt='Live browser']").count() > 0);
  await page.click("button:has-text('Stop session')");
  await page.waitForTimeout(4000);
}
console.log("6. console errors:", errs.length ? errs.slice(0,3) : "none");
await b.close();
