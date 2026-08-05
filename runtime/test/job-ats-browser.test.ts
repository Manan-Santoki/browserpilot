import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";
import { ATS_PLAYBOOKS, hasSubmissionEvidence, type AtsPlaybook } from "@browserpilot/core";

const KINDS = Object.keys(ATS_PLAYBOOKS) as AtsPlaybook["kind"][];
let server: ReturnType<typeof Bun.serve>;
let browser: Browser;

function fixture(kind: AtsPlaybook["kind"], closed: boolean): string {
  const account = ATS_PLAYBOOKS[kind].normallyRequiresAccount;
  return `<!doctype html><html><body data-ats="${kind}">
    <h1>${kind} Browser Automation Engineer</h1>
    <p id="job-id">external-${kind}-123</p>
    ${closed ? '<div role="alert">This job is closed</div>' : `
    <section id="account" ${account ? "" : "hidden"}>
      <h2>Candidate account</h2>
      <input aria-label="Portal email"><input aria-label="Portal password" type="password">
      <button id="reset" type="button">Forgot password</button><output id="reset-state"></output>
    </section>
    <form id="application">
      <input aria-label="Full name" required>
      <input aria-label="Resume" type="file" required>
      <input aria-label="Cover letter" type="file" required>
      <select aria-label="Work authorization"><option value="">Select</option><option>Yes</option><option>No</option></select>
      <input aria-label="Unseen exact question" required>
      <input aria-label="Email verification code" inputmode="numeric" required>
      <label><input id="takeover" type="checkbox"> CAPTCHA completed by user takeover</label>
      <button type="submit">Submit application</button>
    </form>
    <output id="state"></output><div id="confirmation" hidden>Thank you for applying. Reference ${kind}-CONF-123</div>
    <script>
      const resetButton = document.getElementById("reset");
      const resetState = document.getElementById("reset-state");
      const application = document.getElementById("application");
      const takeover = document.getElementById("takeover");
      const state = document.getElementById("state");
      const confirmation = document.getElementById("confirmation");
      if (resetButton) resetButton.onclick = () => resetState.textContent = "Password reset email requested";
      application.addEventListener("submit", event => {
        event.preventDefault();
        if (!takeover.checked) { state.textContent = "needs_takeover"; return; }
        if (!application.reportValidity() || !application.querySelector("select").value) { state.textContent = "needs_answer"; return; }
        state.textContent = "submitted"; confirmation.hidden = false;
      });
    </script>`}
  </body></html>`;
}

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const kind = url.pathname.split("/").filter(Boolean)[0] as AtsPlaybook["kind"];
      if (!KINDS.includes(kind)) return new Response("not found", { status: 404 });
      return new Response(fixture(kind, url.searchParams.get("closed") === "1"), {
        headers: { "content-type": "text/html" },
      });
    },
  });
  browser = await chromium.launch({ headless: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

describe("deterministic ATS browser fixtures", () => {
  for (const kind of KINDS) {
    test(`${kind}: account, documents, questions, Gmail, takeover, and evidence`, async () => {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${server.port}/${kind}/job/123`);
      expect(await page.locator("body").getAttribute("data-ats")).toBe(kind);
      expect(await page.locator("#job-id").textContent()).toBe(`external-${kind}-123`);
      expect(await page.locator("#account").isVisible()).toBe(ATS_PLAYBOOKS[kind].normallyRequiresAccount);
      if (ATS_PLAYBOOKS[kind].normallyRequiresAccount) {
        await page.getByLabel("Portal email").fill("opaque@example.test");
        await page.getByLabel("Portal password").fill("runtime-only-placeholder");
        await page.getByRole("button", { name: "Forgot password" }).click();
        expect(await page.locator("#reset-state").textContent()).toBe("Password reset email requested");
      }
      await page.getByLabel("Full name").fill("Fixture Candidate");
      await page.getByLabel("Resume").setInputFiles({ name: "resume.pdf", mimeType: "application/pdf", buffer: Buffer.from("resume") });
      await page.getByLabel("Cover letter").setInputFiles({ name: "cover-letter.pdf", mimeType: "application/pdf", buffer: Buffer.from("cover") });
      await page.getByLabel("Work authorization").selectOption("Yes");
      await page.getByLabel("Unseen exact question").fill("Saved only after exact answer collection");
      await page.getByLabel("Email verification code").fill("123456");

      await page.getByRole("button", { name: "Submit application" }).click();
      expect(await page.locator("#state").textContent()).toBe("needs_takeover");
      await page.getByLabel("CAPTCHA completed by user takeover").check();
      await page.getByRole("button", { name: "Submit application" }).click();
      expect(await page.locator("#state").textContent()).toBe("submitted");
      const confirmationText = await page.locator("#confirmation").textContent();
      expect(hasSubmissionEvidence({ confirmationText: confirmationText ?? undefined })).toBe(true);
      await page.close();
    });

    test(`${kind}: closed jobs produce no application form`, async () => {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${server.port}/${kind}/job/123?closed=1`);
      expect(await page.getByRole("alert").textContent()).toContain("closed");
      expect(await page.locator("#application").count()).toBe(0);
      await page.close();
    });
  }
});
