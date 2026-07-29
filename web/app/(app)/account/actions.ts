"use server";

import { eq } from "drizzle-orm";
import { hashPassword, verifyPassword } from "@browserpilot/core";
import { users, webSessions } from "@browserpilot/db";
import { audit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";

export type AccountState = { error?: string; success?: string };

export async function changePassword(
  _prev: AccountState,
  formData: FormData,
): Promise<AccountState> {
  const user = await requireUser();

  const current = String(formData.get("current") ?? "");
  const next = String(formData.get("next") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  if (next.length < 12) return { error: "Choose a password of at least 12 characters." };
  if (next !== confirm) return { error: "The two new passwords do not match." };
  if (next === current) return { error: "That is your current password." };

  const [row] = await db()
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);

  if (!row || !(await verifyPassword(current, row.passwordHash))) {
    return { error: "Your current password is not right." };
  }

  await db()
    .update(users)
    .set({ passwordHash: await hashPassword(next), updatedAt: new Date() })
    .where(eq(users.id, user.id));

  // Anyone signed in elsewhere with the old password loses that session — the
  // point of changing a password is usually that someone else may have it.
  await db().update(webSessions).set({ revokedAt: new Date() }).where(eq(webSessions.userId, user.id));

  await audit({ actorUserId: user.id, action: "user.updated", metadata: { passwordChanged: true } });

  return {
    success: "Password changed. Other signed-in devices have been signed out.",
  };
}

export async function setLanguage(formData: FormData): Promise<void> {
  const user = await requireUser();
  const language = String(formData.get("language") ?? "en");
  if (!["en", "hi", "gu"].includes(language)) return;

  await db().update(users).set({ preferredLanguage: language }).where(eq(users.id, user.id));
}
