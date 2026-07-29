"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { generateToken } from "@browserpilot/core";
import { invites, settings, users } from "@browserpilot/db";
import { audit } from "@/lib/audit";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";

export type AdminState = { error?: string; success?: string; inviteUrl?: string };

const INVITE_TTL_DAYS = 7;

/**
 * Invites are the only route to an account. The link is shown once, here —
 * there is no mail server configured, and a link an admin copies by hand is
 * one fewer moving part to trust.
 */
export async function inviteUser(_prev: AdminState, formData: FormData): Promise<AdminState> {
  const admin = await requireAdmin();

  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const role = String(formData.get("role") ?? "USER") === "ADMIN" ? "ADMIN" : "USER";
  if (!email.includes("@")) return { error: "Enter a valid email address." };

  const [existing] = await db()
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (existing) return { error: "Someone with that email already has an account." };

  const { token, hash } = generateToken();
  await db()
    .insert(invites)
    .values({
      email,
      role,
      tokenHash: hash,
      invitedById: admin.id,
      expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000),
    });

  await audit({
    actorUserId: admin.id,
    action: "user.invited",
    targetType: "invite",
    metadata: { email, role },
  });

  const base = process.env.BP_WEB_URL ?? "http://127.0.0.1:3000";
  revalidatePath("/admin/users");
  return {
    success: `Invited ${email}. The link below works once, and expires in ${INVITE_TTL_DAYS} days.`,
    inviteUrl: `${base}/invite/${token}`,
  };
}

export async function setUserActive(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const userId = String(formData.get("userId") ?? "");
  const active = String(formData.get("active") ?? "") === "true";

  // Locking yourself out is never the intent, and an empty admin set would
  // leave nobody able to fix it.
  if (userId === admin.id) return;

  await db().update(users).set({ isActive: active }).where(eq(users.id, userId));
  await audit({
    actorUserId: admin.id,
    action: "user.updated",
    targetType: "user",
    targetId: userId,
    metadata: { isActive: active },
  });
  revalidatePath("/admin/users");
}

export async function setUserRole(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const userId = String(formData.get("userId") ?? "");
  const role = String(formData.get("role") ?? "") === "ADMIN" ? "ADMIN" : "USER";

  if (userId === admin.id) return;

  await db().update(users).set({ role }).where(eq(users.id, userId));
  await audit({
    actorUserId: admin.id,
    action: "user.updated",
    targetType: "user",
    targetId: userId,
    metadata: { role },
  });
  revalidatePath("/admin/users");
}

const NUMERIC_SETTINGS = [
  "perUserSessionLimit",
  "globalSessionLimit",
  "idleTimeoutMs",
  "hardCapMs",
] as const;

export async function saveSettings(_prev: AdminState, formData: FormData): Promise<AdminState> {
  const admin = await requireAdmin();

  const writes: Array<{ key: string; value: unknown }> = [];

  for (const key of NUMERIC_SETTINGS) {
    const raw = String(formData.get(key) ?? "").trim();
    if (!raw) continue;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      return { error: `${key} must be a positive number.` };
    }
    writes.push({ key, value });
  }

  const model = String(formData.get("defaultModel") ?? "").trim();
  if (model) writes.push({ key: "defaultModel", value: model });

  for (const write of writes) {
    await db()
      .insert(settings)
      .values({ key: write.key, value: write.value, updatedById: admin.id })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: write.value, updatedById: admin.id, updatedAt: new Date() },
      });
  }

  await audit({
    actorUserId: admin.id,
    action: "settings.updated",
    metadata: Object.fromEntries(writes.map((w) => [w.key, w.value])),
  });

  revalidatePath("/admin/settings");
  return { success: "Saved. New sessions use these limits immediately." };
}
