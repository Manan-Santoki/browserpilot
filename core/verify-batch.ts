import { chromium } from "playwright";
const BASE = "https://browserpilot.msantoki.com";
const b = await chromium.launch({ headless: true });
const page = await b.newPage();

await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
await page.fill("#email", "manansantoki2003@gmail.com");
await page.fill("#password", "browserpilot-dev-2026");
await page.click("button[type=submit]");
await page.waitForURL(u => u.pathname === "/", { timeout: 40000 });

console.log("1. model dropdown present:", await page.locator("select[name=model]").count() > 0);
await page.goto(`${BASE}/sites`, { waitUntil: "domcontentloaded" });
console.log("2. delete-site control present:", await page.locator("button:has-text('Delete site')").count() > 0);

await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.selectOption("select[name=siteProfileId]", { label: "JWM ERP" });
await page.selectOption("select[name=model]", "claude-sonnet-5");
await page.fill("input[name=title]", "download + restart check");
await page.click("button:has-text('New session')");
await page.waitForURL(u => u.pathname.startsWith("/sessions/"), { timeout: 120000 });
await page.waitForTimeout(9000);
console.log("3. session started with chosen model:", page.url());
console.log("4. restart control present:", await page.locator("button:has-text('Restart browser')").count() > 0);

// Ask it to download a PO PDF, then check the link actually works.
const composer = page.locator("input[placeholder*='Tell the robot']");
await composer.fill("Go to Purchase Orders, open the most recent one, and download its PDF. Read-only otherwise.");
await page.keyboard.press("Enter");

let fileHref: string | null = null;
for (let i = 0; i < 120; i++) {
  const link = page.locator("a[href*='/files/']").first();
  if (await link.count() > 0) { fileHref = await link.getAttribute("href"); break; }
  await page.waitForTimeout(2500);
}
console.log("5. file link produced:", fileHref ?? "(none within timeout)");

if (fileHref) {
  const res = await page.request.get(new URL(fileHref, BASE).toString());
  console.log("6. download status:", res.status(), "| content-type:", res.headers()["content-type"]);
  const body = await res.body();
  console.log("7. bytes:", body.length, "| looks like PDF:", body.subarray(0,4).toString() === "%PDF");
  console.log("8. Files section lists it:", (await page.textContent("body"))?.includes("Files ("));
}

await page.click("button:has-text('Stop session')");
await b.close();
