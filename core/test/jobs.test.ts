import { describe, expect, test } from "bun:test";
import {
  assertPublicJobUrl,
  atsPlaybook,
  detectAts,
  generatePortalPassword,
  hasSubmissionEvidence,
  jobAnswerMatchKey,
  jobAnswerMatchCandidates,
  jobOptionSignature,
  normalizeJobQuestion,
  normalizeJobUrl,
  notificationRetryAt,
  parseGmailVerification,
  portalAccountKey,
  parseJobPlaceholder,
  redactJobToolInput,
  resolvePublicJobUrl,
  substituteJobPlaceholders,
  validateJobAnswer,
  validateApplicationInventory,
} from "../src/jobs";

describe("job safety utilities", () => {
  test("normalizes duplicate links", () => {
    expect(normalizeJobUrl("https://EXAMPLE.com/jobs/1/?utm_source=x&team=eng#apply"))
      .toBe("https://example.com/jobs/1?team=eng");
    expect(normalizeJobUrl("https://example.com/jobs/1?gh_jid=4830113101&jobPipeline=IndeedITA"))
      .toBe("https://example.com/jobs/1?gh_jid=4830113101");
  });
  test("rejects unsafe destinations", () => {
    expect(assertPublicJobUrl("https://jobs.lever.co/acme/123").hostname).toBe("jobs.lever.co");
    expect(() => assertPublicJobUrl("http://example.com/job")).toThrow("HTTPS");
    expect(() => assertPublicJobUrl("https://127.0.0.1/job")).toThrow("Private");
    expect(() => assertPublicJobUrl("https://169.254.169.254/latest/meta-data")).toThrow("Private");
  });
  test("detects supported ATS hosts", () => {
    expect(detectAts("https://boards.greenhouse.io/acme/jobs/1")).toBe("greenhouse");
    expect(detectAts("https://www.asm.com/open-vacancies/software-engineering-intern?gh_jid=4830113101&jobPipeline=IndeedITA"))
      .toBe("greenhouse");
    expect(detectAts("https://example.com/careers/1")).toBe("generic");
  });
  test("normalizes exact reusable questions", () => {
    expect(normalizeJobQuestion("Will you now require sponsorship? (Required)"))
      .toBe("will_you_now_require_sponsorship");
  });
  test("generates strong, non-repeating passwords", () => {
    const first = generatePortalPassword();
    expect(first).not.toBe(generatePortalPassword());
    expect(first).toMatch(/[a-z]/); expect(first).toMatch(/[A-Z]/);
    expect(first).toMatch(/[0-9]/); expect(first).toMatch(/[^a-zA-Z0-9]/);
  });
  test("recognizes placeholders and redacts nested input", () => {
    expect(parseJobPlaceholder("{{BP_SECRET:abc_1}}")).toEqual({ kind: "SECRET", id: "abc_1" });
    expect(redactJobToolInput({ fields: [{ name: "password", value: "hello" }] }))
      .toEqual({ fields: [{ name: "password", value: "[redacted]" }] });
  });

  test("binds saved choices to an exact normalized question and option signature", () => {
    const first = jobAnswerMatchKey("Preferred location?", "single_choice", ["Remote", "Phoenix"]);
    expect(first).toBe(jobAnswerMatchKey("Preferred location? (Required)", "single_choice", ["Phoenix", "Remote"]));
    expect(first).not.toBe(jobAnswerMatchKey("Which location do you prefer?", "single_choice", ["Phoenix", "Remote"]));
    expect(first).not.toBe(jobAnswerMatchKey("Preferred location?", "single_choice", ["Phoenix", "Tempe"]));
    const countries = Array.from({ length: 247 }, (_, index) => `Country ${index}`);
    expect(jobOptionSignature("single_choice", countries).length).toBeLessThan(100);
    expect(jobAnswerMatchCandidates("Country?", "single_choice", countries)).toHaveLength(2);
  });

  test("validates answers against the portal's exact option inventory", () => {
    expect(validateJobAnswer("single_choice", ["Authorized for any employer", "Status unknown"], "Authorized for any employer")).toBe(true);
    expect(validateJobAnswer("single_choice", ["Authorized for any employer", "Status unknown"], "Yes")).toBe(false);
    expect(validateJobAnswer("multi_choice", ["A", "B"], ["A", "B"])).toBe(true);
    expect(validateJobAnswer("multi_choice", ["A", "B"], ["A", "A"])).toBe(false);
    expect(validateJobAnswer("number", [], Number.NaN)).toBe(false);
  });

  test("checks DNS answers so hostnames cannot resolve into private infrastructure", async () => {
    const safe = await resolvePublicJobUrl("https://jobs.example.com/1", async () => [{ address: "203.0.113.10", family: 4 }]);
    expect(safe.addresses).toEqual(["203.0.113.10"]);
    await expect(resolvePublicJobUrl("https://jobs.example.com/1", async () => [
      { address: "203.0.113.10", family: 4 }, { address: "10.0.0.2", family: 4 },
    ])).rejects.toThrow("private");
  });

  test("defines account and confirmation behavior for every supported ATS", () => {
    expect(atsPlaybook("https://tenant.myworkdayjobs.com/en-US/job/1").accountScope).toBe("tenant_origin");
    expect(atsPlaybook("https://jobs.ashbyhq.com/acme/1").kind).toBe("ashby");
    expect(atsPlaybook("https://example.com/careers/1").kind).toBe("generic");
  });

  test("derives portal-account scope without trusting model-provided keys", () => {
    expect(portalAccountKey("https://boards.greenhouse.io/acme/jobs/1")).toBe("portal:greenhouse");
    expect(portalAccountKey("https://acme.wd5.myworkdayjobs.com/en-US/jobs/job/1"))
      .toBe("tenant:https://acme.wd5.myworkdayjobs.com");
    expect(portalAccountKey("https://careers.example.com/jobs/1"))
      .toBe("origin:https://careers.example.com");
  });

  test("substitutes opaque values only at execution time", async () => {
    const result = await substituteJobPlaceholders({ value: "{{BP_PROFILE:email}}", keep: "label" }, async (token) => `${token.kind}:${token.id}:resolved`);
    expect(result).toEqual({ value: "PROFILE:email:resolved", keep: "label" });
  });

  test("blocks submit until inventory is complete and requires post-submit evidence", () => {
    const blocked = validateApplicationInventory({
      requiredFields: [{ key: "email", handled: true }, { key: "sponsorship", handled: false }],
      unresolvedQuestionIds: ["q1"], resumeStaged: true, coverLetterRequired: true,
      coverLetterStaged: false, consentGranted: true, unusualLegalLanguage: false,
    });
    expect(blocked.ok).toBe(false);
    expect(hasSubmissionEvidence({})).toBe(false);
    expect(hasSubmissionEvidence({ referenceId: "APP-42" })).toBe(true);
  });

  test("parses verification codes and allow-listed links without retaining a message", () => {
    expect(parseGmailVerification("Your verification code is 483921.")).toEqual({ code: "483921" });
    expect(parseGmailVerification("Verify: https://auth.example.com/verify?t=abc", ["auth.example.com"]))
      .toEqual({ link: "https://auth.example.com/verify?t=abc" });
    expect(parseGmailVerification("Verify: https://evil.example/verify", ["auth.example.com"])).toEqual({});
  });

  test("notification retries use bounded exponential backoff", () => {
    expect(notificationRetryAt(1, 0).getTime()).toBe(30_000);
    expect(notificationRetryAt(3, 0).getTime()).toBe(120_000);
    expect(notificationRetryAt(99, 0).getTime()).toBeLessThanOrEqual(24 * 60 * 60 * 1_000);
  });
});
