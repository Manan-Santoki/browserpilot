/**
 * Screenshots the console's main pages into /tmp so a change can be looked at
 * rather than assumed. Point it at a running console:
 *
 *   BP_EMAIL=… BP_PASSWORD=… bun run scripts/ui-screenshots.ts [port]
 */
import { chromium } from "playwright";

const port = process.argv[2] ?? "3100";
const base = `http://localhost:${port}`;
const email = process.env.BP_EMAIL;
const password = process.env.BP_PASSWORD;

if (!email || !password) {
  console.error("Set BP_EMAIL and BP_PASSWORD to a console account.");
  process.exit(1);
}

const b = await chromium.launch({ headless: true });
const page = await b.newPage({ viewport: { width: 1400, height: 900 } });

await page.goto(`${base}/login`, { waitUntil: "networkidle" });
await page.fill("#email", email);
await page.fill("#password", password);
await page.click("button[type=submit]");
await page.waitForURL((u) => u.pathname === "/", { timeout: 30000 });
await page.waitForTimeout(1500);
await page.screenshot({ path: "/tmp/ui-dashboard.png" });

// The confirm dialog on a live session card.
const stop = page.getByRole("button", { name: "Stop", exact: true }).first();
if ((await stop.count()) > 0) {
  await stop.click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: "/tmp/ui-confirm.png" });
  await page.getByRole("button", { name: "Keep it" }).click();
  await page.waitForTimeout(500);
  const stillThere = await page.getByRole("button", { name: "Stop", exact: true }).count();
  console.log(`confirm: opened, cancelled; session still listed = ${stillThere > 0}`);
} else {
  console.log("confirm: no live session on the dashboard to test");
}

await page.goto(`${base}/sites`, { waitUntil: "networkidle" });
await page.screenshot({ path: "/tmp/ui-sites.png" });
const del = page.getByRole("button", { name: "Delete", exact: true }).first();
if ((await del.count()) > 0) {
  await del.click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: "/tmp/ui-confirm-site.png" });
  console.log("confirm: site delete dialog captured");
}

await page.goto(`${base}/account`, { waitUntil: "networkidle" });
await page.screenshot({ path: "/tmp/ui-account.png" });

await b.close();
console.log("done");
