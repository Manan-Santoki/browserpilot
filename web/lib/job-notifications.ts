import { eq } from "drizzle-orm";
import { decryptSecret } from "@browserpilot/core";
import { jobCandidateProfiles, notificationOutbox } from "@browserpilot/db";
import { db } from "@/lib/db";

/** Commit a secret-free status notification without coupling delivery to the UI action. */
export async function enqueueJobNotification(
  userId: string,
  applicationId: string,
  template: string,
  message: string,
): Promise<void> {
  const [profile] = await db().select({ notificationEmailEncrypted: jobCandidateProfiles.notificationEmailEncrypted })
    .from(jobCandidateProfiles).where(eq(jobCandidateProfiles.userId, userId)).limit(1);
  const key = process.env.BP_MASTER_KEY;
  if (!profile || !key) return;
  await db().insert(notificationOutbox).values({
    userId,
    applicationId,
    dedupeKey: `${applicationId}:${template}`,
    toEmail: decryptSecret(profile.notificationEmailEncrypted, key),
    template,
    payload: { applicationId, message },
  }).onConflictDoNothing();
}
