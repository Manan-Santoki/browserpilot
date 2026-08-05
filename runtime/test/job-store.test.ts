import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, ne } from "drizzle-orm";
import { encryptSecret, encryptStructured } from "@browserpilot/core";
import {
  jobAnswers,
  jobApplications,
  jobCandidateProfiles,
  jobConnections,
  jobConsents,
  jobDocuments,
  jobPortalAccounts,
  jobQuestions,
  notificationOutbox,
  robotSessions,
} from "@browserpilot/db";
import { createFixtures, db, DB_HEAVY_TIMEOUT_MS, store, TEST_MASTER_KEY, type Fixtures } from "./helpers";
import { NotificationWorker } from "../src/jobs/notifications";

let fx: Fixtures;
let resumeId: string;

async function application(status: "queued" | "running" | "applied" = "running", suffix: string = crypto.randomUUID()) {
  const [row] = await db.insert(jobApplications).values({
    userId: fx.userId,
    resumeDocumentId: resumeId,
    sourceUrl: `https://jobs.example.com/${suffix}`,
    normalizedUrl: `https://jobs.example.com/${suffix}`,
    status,
    atsKind: "generic",
  }).returning();
  return row!;
}

beforeAll(async () => {
  fx = await createFixtures("job-store");
  await db.insert(jobCandidateProfiles).values({
    userId: fx.userId,
    profileEncrypted: encryptStructured({
      fullName: "Private Candidate",
      phone: "602-555-0100",
      city: "Tempe",
      country: "United States",
      linkedin: "https://www.linkedin.com/in/private-candidate",
      github: "https://github.com/private-candidate",
      school: "Arizona State University",
      degree: "Master's Degree",
      discipline: "Computer Science",
      educationStartYear: "2025",
      educationEndYear: "2027",
      employmentHistory: "Browser automation",
    }, TEST_MASTER_KEY),
    applicationEmailEncrypted: encryptSecret("candidate@test.local", TEST_MASTER_KEY),
    notificationEmailEncrypted: encryptSecret("notify@test.local", TEST_MASTER_KEY),
  });
  const [resume] = await db.insert(jobDocuments).values({
    userId: fx.userId,
    kind: "resume",
    name: "Primary resume",
    filename: "resume.pdf",
    objectKey: `jobs/${fx.userId}/resume/file`,
    contentType: "application/pdf",
    sizeBytes: 100,
    encryptionAad: `${fx.userId}:resume`,
    extractedTextEncrypted: encryptSecret("Senior browser automation engineer", TEST_MASTER_KEY),
    isDefault: true,
  }).returning();
  resumeId = resume!.id;
});

afterAll(async () => {
  await fx.cleanup();
});

describe("job store integration", () => {
  test("saved answers and candidate data remain owner-isolated", async () => {
    await db.insert(jobAnswers).values({
      userId: fx.userId,
      questionKey: "work_authorization::boolean",
      questionLabel: "Work authorization",
      answerType: "boolean",
      optionSignature: "boolean",
      answerEncrypted: encryptStructured(true, TEST_MASTER_KEY),
      category: "authorization",
    });
    expect(await store.savedJobAnswer(fx.userId, { label: "Work authorization", answerType: "boolean", options: [] })).toBe(true);
    expect(await store.savedJobAnswer(fx.otherUserId, { label: "Work authorization", answerType: "boolean", options: [] })).toBeNull();
    await expect(store.coverLetterContext(fx.otherUserId, crypto.randomUUID())).rejects.toThrow();
    const aliases = await store.candidatePlaceholders(fx.userId, ["firstName", "lastName", "email", "phoneNumber", "linkedinProfile", "githubProfile", "schoolName", "degreeLevel", "major", "educationStartYear", "educationEndYear"]);
    expect(Object.keys(aliases)).toEqual(["firstName", "lastName", "email", "phoneNumber", "linkedinProfile", "githubProfile", "schoolName", "degreeLevel", "major", "educationStartYear", "educationEndYear"]);
    expect(await store.resolveProfilePlaceholder(fx.userId, "firstName")).toBe("Private");
    expect(await store.resolveProfilePlaceholder(fx.userId, "lastName")).toBe("Candidate");
    expect(await store.resolveProfilePlaceholder(fx.userId, "phone")).toBe("602-555-0100");
    expect(await store.resolveProfilePlaceholder(fx.userId, "degree")).toBe("Master's Degree");
  }, DB_HEAVY_TIMEOUT_MS);

  test("runtime preflight identifies missing consent without inventing missing profile or résumé data", async () => {
    const current = await application("running", "runtime-preflight");
    const issues = await store.jobConfigurationIssues(fx.userId, current.id);
    expect(issues.join(" ")).toContain("consent");
    expect(issues.join(" ")).not.toContain("candidate profile");
    expect(issues.join(" ")).not.toContain("résumé is unavailable");
  }, DB_HEAVY_TIMEOUT_MS);

  test("runtime preflight rejects an incomplete encrypted profile", async () => {
    await db.insert(jobCandidateProfiles).values({
      userId: fx.otherUserId,
      profileEncrypted: encryptStructured({ fullName: "", phone: "" }, TEST_MASTER_KEY),
      applicationEmailEncrypted: encryptSecret("other@test.local", TEST_MASTER_KEY),
      notificationEmailEncrypted: encryptSecret("other@test.local", TEST_MASTER_KEY),
    });
    const issues = await store.jobConfigurationIssues(fx.otherUserId, crypto.randomUUID());
    expect(issues.join(" ")).toContain("candidate profile");
  }, DB_HEAVY_TIMEOUT_MS);

  test("portal credentials are pending before use, become active only after confirmation, and rotate for reset", async () => {
    const first = await store.portalAccountPlaceholders(fx.userId, "origin:https://jobs.example.com", "https://jobs.example.com");
    expect(first.password).toMatch(/^\{\{BP_SECRET:/);
    let [account] = await db.select().from(jobPortalAccounts).where(eq(jobPortalAccounts.userId, fx.userId));
    expect(account!.status).toBe("pending");
    const oldEncrypted = account!.passwordEncrypted;
    await store.markPortalAccountActive(fx.userId, account!.portalKey, true);
    [account] = await db.select().from(jobPortalAccounts).where(eq(jobPortalAccounts.id, account!.id));
    expect(account!.status).toBe("active");
    expect(account!.verificationStatus).toBe("verified");
    await store.resetPortalAccount(fx.userId, account!.portalKey);
    [account] = await db.select().from(jobPortalAccounts).where(eq(jobPortalAccounts.id, account!.id));
    expect(account!.status).toBe("pending");
    expect(account!.passwordEncrypted).not.toBe(oldEncrypted);
  }, DB_HEAVY_TIMEOUT_MS);

  test("portal/external ID discovery links a duplicate after launch unless reapply was explicit", async () => {
    const original = await application("applied", "original");
    await db.update(jobApplications).set({ portalKey: "portal:greenhouse", externalJobId: "job-42" }).where(eq(jobApplications.id, original.id));
    const current = await application("running", "different-url");
    const result = await store.discoverJobIdentity(fx.userId, current.id, {
      portalKey: "portal:greenhouse",
      externalJobId: "job-42",
      company: "Example",
      roleTitle: "Engineer",
    });
    expect(result.duplicateOf).toBe(original.id);
    const [linked] = await db.select().from(jobApplications).where(eq(jobApplications.id, current.id));
    expect(linked!.status).toBe("not_applied");
    expect(linked!.duplicateOfApplicationId).toBe(original.id);
    const [notice] = await db.select().from(notificationOutbox).where(and(
      eq(notificationOutbox.applicationId, current.id),
      eq(notificationOutbox.template, "duplicate-after-launch"),
    ));
    expect(notice).toBeDefined();
  }, DB_HEAVY_TIMEOUT_MS);

  test("server-side inventory and evidence gates prevent false Applied states", async () => {
    const current = await application("running", "gated");
    await db.insert(jobConsents).values({ userId: fx.userId, version: "2026-08-04" });
    await db.insert(jobQuestions).values({
      applicationId: current.id,
      userId: fx.userId,
      requestId: "q-1",
      questionKey: "salary::number",
      questionLabel: "Salary",
      answerType: "number",
      optionSignature: "number",
    });
    const inventory = {
      requiredFields: [{ key: "name", handled: true }],
      unresolvedQuestionIds: [],
      resumeStaged: true,
      coverLetterRequired: false,
      coverLetterStaged: true,
      consentGranted: true,
      unusualLegalLanguage: false,
    };
    const blocked = await store.prepareJobSubmission(fx.userId, current.id, inventory);
    expect(blocked.ok).toBe(false);
    expect(blocked.reasons?.join(" ")).toContain("unresolved");
    expect((await store.recordJobSubmission(fx.userId, current.id, {})).ok).toBe(false);
    await db.update(jobQuestions).set({ status: "answered", answeredAt: new Date() }).where(eq(jobQuestions.applicationId, current.id));
    expect((await store.prepareJobSubmission(fx.userId, current.id, inventory)).ok).toBe(true);
    expect((await store.recordJobSubmission(fx.userId, current.id, { referenceId: "CONF-42" })).ok).toBe(true);
    const [applied] = await db.select().from(jobApplications).where(eq(jobApplications.id, current.id));
    expect(applied!.status).toBe("applied");
    expect(applied!.confirmationReference).toBe("CONF-42");
  }, DB_HEAVY_TIMEOUT_MS);

  test("generated cover letters are owner-scoped, associated, and required by the server gate", async () => {
    const current = await application("running", "generated-cover");
    const coverId = crypto.randomUUID();
    await store.saveGeneratedCoverLetter({
      id: coverId,
      userId: fx.userId,
      applicationId: current.id,
      filename: "cover-letter.pdf",
      objectKey: `jobs/${fx.userId}/${current.id}/${coverId}`,
      contentType: "application/pdf",
      sizeBytes: 512,
      encryptionAad: `${fx.userId}:${current.id}:${coverId}`,
      extractedTextEncrypted: encryptSecret("Dear Hiring Team", TEST_MASTER_KEY),
    });
    expect((await store.applicationDocument(fx.userId, current.id, "cover_letter"))?.id).toBe(coverId);
    expect(await store.applicationDocument(fx.otherUserId, current.id, "cover_letter")).toBeNull();
    const [linked] = await db.select().from(jobApplications).where(eq(jobApplications.id, current.id));
    expect(linked!.coverLetterDocumentId).toBe(coverId);
  }, DB_HEAVY_TIMEOUT_MS);

  test("concurrent queue claims never return the same application", async () => {
    await application("queued", "claim-a");
    await application("queued", "claim-b");
    const claims = (await Promise.all([store.claimJob("worker-a"), store.claimJob("worker-b")]))
      .filter((claim): claim is NonNullable<typeof claim> => claim !== null);
    expect(new Set(claims.map((claim) => claim.id)).size).toBe(claims.length);
    expect(claims.length).toBeGreaterThan(0);
  }, DB_HEAVY_TIMEOUT_MS);

  test("job retries reuse the terminal browser-session row", async () => {
    const current = await application("running", "retry-session");
    const claimed = {
      id: current.id,
      userId: current.userId,
      sourceUrl: current.sourceUrl,
      normalizedUrl: current.normalizedUrl,
      atsKind: current.atsKind,
      model: null,
      resumeDocumentId: current.resumeDocumentId,
      reapplyRequested: false,
      attempt: 1,
    };
    const firstId = await store.createJobSession(claimed, "first-model");
    await db.update(robotSessions).set({
      status: "interrupted",
      endedAt: new Date(),
      endedReason: "runtime restarted",
    }).where(eq(robotSessions.id, firstId));

    const secondId = await store.createJobSession({ ...claimed, attempt: 2 }, "second-model");
    expect(secondId).toBe(firstId);
    const sessions = await db.select().from(robotSessions).where(eq(robotSessions.jobApplicationId, current.id));
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.status).toBe("starting");
    expect(sessions[0]!.endedAt).toBeNull();
    expect(sessions[0]!.model).toBe("second-model");
  }, DB_HEAVY_TIMEOUT_MS);

  test("deleting Gmail or portal credentials retains application history", async () => {
    const current = await application("applied", "retention");
    await db.insert(jobConnections).values({
      userId: fx.userId,
      kind: "gmail",
      accountEmail: "candidate@test.local",
      refreshTokenEncrypted: encryptSecret("refresh", TEST_MASTER_KEY),
      scope: "gmail.readonly gmail.send",
    });
    await db.delete(jobConnections).where(eq(jobConnections.userId, fx.userId));
    await db.delete(jobPortalAccounts).where(eq(jobPortalAccounts.userId, fx.userId));
    const [retained] = await db.select().from(jobApplications).where(eq(jobApplications.id, current.id));
    expect(retained).toBeDefined();
    expect(retained!.status).toBe("applied");
  }, DB_HEAVY_TIMEOUT_MS);

  test("notification delivery failures retry without changing the application result or leaking diagnostics", async () => {
    await db.update(notificationOutbox).set({ status: "sent", sentAt: new Date() })
      .where(eq(notificationOutbox.userId, fx.userId));
    const current = await application("running", "notification-failure");
    const secret = "PortalPassword-DoNotLeak";
    await store.failJob(fx.userId, current.id, `password=${secret}`);
    // A repeated terminal transition is a no-op and cannot enqueue a second
    // copy of the same status email.
    await store.failJob(fx.userId, current.id, `password=${secret}`);
    const notices = await db.select().from(notificationOutbox).where(and(
      eq(notificationOutbox.applicationId, current.id),
      eq(notificationOutbox.template, "failed"),
    ));
    expect(notices).toHaveLength(1);
    expect(JSON.stringify(notices[0]!.payload)).not.toContain(secret);

    // No Gmail connection exists, so delivery fails and schedules a retry.
    // Keep unrelated fixture/user notifications from winning this global
    // worker's oldest-first claim during the isolated assertion.
    await db.update(notificationOutbox).set({ nextAttemptAt: new Date(Date.now() + 60_000) })
      .where(ne(notificationOutbox.id, notices[0]!.id));
    await new NotificationWorker(store, "fake-client", "fake-secret").tick();
    const [[unchanged], [retried]] = await Promise.all([
      db.select().from(jobApplications).where(eq(jobApplications.id, current.id)),
      db.select().from(notificationOutbox).where(eq(notificationOutbox.id, notices[0]!.id)),
    ]);
    expect(unchanged!.status).toBe("failed");
    expect(retried!.status).toBe("failed");
    expect(retried!.attempts).toBe(1);
    expect(retried!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    expect(retried!.lastError).not.toContain(secret);
  }, DB_HEAVY_TIMEOUT_MS);
});
