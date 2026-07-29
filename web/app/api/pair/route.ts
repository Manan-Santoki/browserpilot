import { NextResponse } from "next/server";
import { and, eq, gt, isNull } from "drizzle-orm";
import { generateToken, hashToken } from "@browserpilot/core";
import { pairingCodes, remoteDevices, users } from "@browserpilot/db";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";

/**
 * Exchange a scanned pairing code for a device token.
 *
 * This is the one unauthenticated endpoint in the console, so it is
 * deliberately narrow: the code is single-use, expires in minutes, and is
 * matched by digest. A wrong or stale code returns the same message as an
 * unknown one, so the endpoint cannot be used to probe for valid codes.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { code?: string; deviceName?: string };
  const code = String(body.code ?? "").trim().toUpperCase();
  const deviceName = String(body.deviceName ?? "").trim().slice(0, 80) || "Phone";

  if (!code) return NextResponse.json({ error: "A pairing code is required" }, { status: 400 });

  const [pairing] = await db()
    .select({ id: pairingCodes.id, userId: pairingCodes.userId })
    .from(pairingCodes)
    .where(
      and(
        eq(pairingCodes.codeHash, hashToken(code)),
        gt(pairingCodes.expiresAt, new Date()),
        isNull(pairingCodes.claimedAt),
      ),
    )
    .limit(1);

  if (!pairing) {
    return NextResponse.json({ error: "That code is not valid or has expired" }, { status: 404 });
  }

  const [owner] = await db()
    .select({ id: users.id, name: users.name, email: users.email, isActive: users.isActive })
    .from(users)
    .where(eq(users.id, pairing.userId))
    .limit(1);

  if (!owner?.isActive) {
    return NextResponse.json({ error: "That account is not active" }, { status: 403 });
  }

  const { token, hash } = generateToken();

  await db().insert(remoteDevices).values({
    userId: owner.id,
    name: deviceName,
    tokenHash: hash,
    lastSeenAt: new Date(),
  });

  // Burn the code — a scan is a one-time event.
  await db().update(pairingCodes).set({ claimedAt: new Date() }).where(eq(pairingCodes.id, pairing.id));

  await audit({
    actorUserId: owner.id,
    action: "device.paired",
    targetType: "device",
    metadata: { deviceName },
  });

  return NextResponse.json({
    token,
    user: { id: owner.id, name: owner.name, email: owner.email },
  });
}
