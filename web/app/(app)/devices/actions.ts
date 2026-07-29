"use server";

import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { generatePairingCode } from "@browserpilot/core";
import { pairingCodes, remoteDevices } from "@browserpilot/db";
import { audit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";

/** Long enough to scan, short enough that a screenshot left open goes stale. */
const CODE_TTL_MS = 5 * 60 * 1000;

export type PairingState = { error?: string; code?: string; expiresAt?: string };

export async function createPairingCode(): Promise<PairingState> {
  const user = await requireUser();

  // Only one live code per person: an old one still floating around is a
  // credential nobody is watching.
  await db()
    .update(pairingCodes)
    .set({ claimedAt: new Date() })
    .where(and(eq(pairingCodes.userId, user.id), isNull(pairingCodes.claimedAt)));

  const { token, hash } = generatePairingCode();
  const expiresAt = new Date(Date.now() + CODE_TTL_MS);

  await db().insert(pairingCodes).values({ userId: user.id, codeHash: hash, expiresAt });

  revalidatePath("/devices");
  return { code: token, expiresAt: expiresAt.toISOString() };
}

export async function revokeDevice(formData: FormData): Promise<void> {
  const user = await requireUser();
  const deviceId = String(formData.get("deviceId") ?? "");
  if (!deviceId) return;

  await db()
    .update(remoteDevices)
    .set({ revokedAt: new Date() })
    .where(and(eq(remoteDevices.id, deviceId), eq(remoteDevices.userId, user.id)));

  await audit({
    actorUserId: user.id,
    action: "device.revoked",
    targetType: "device",
    targetId: deviceId,
  });

  revalidatePath("/devices");
}
