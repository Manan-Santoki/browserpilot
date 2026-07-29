import { NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { generateToken, hashToken } from "@browserpilot/core";
import { remoteDevices, users, webSessions } from "@browserpilot/db";
import { db } from "@/lib/db";

/**
 * Exchange a paired device's token for a session.
 *
 * Pairing hands the phone a long-lived device token, which it keeps in the
 * platform keystore and never sends anywhere except here. This trades it for a
 * short-lived session token — the same kind the console holds in a cookie — so
 * every route already written for the browser serves the app too, and a stolen
 * session expires on its own.
 *
 * Revoking the device on the Devices page stops this exchange, which is what
 * makes that button mean anything.
 */
const SESSION_TTL_DAYS = 30;

export async function POST(req: Request) {
  const header = req.headers.get("authorization") ?? "";
  const deviceToken = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";

  if (!deviceToken) {
    return NextResponse.json({ error: "A device token is required" }, { status: 401 });
  }

  const [device] = await db()
    .select({
      id: remoteDevices.id,
      name: remoteDevices.name,
      userId: remoteDevices.userId,
      userName: users.name,
      userEmail: users.email,
      userRole: users.role,
      preferredLanguage: users.preferredLanguage,
      isActive: users.isActive,
    })
    .from(remoteDevices)
    .innerJoin(users, eq(users.id, remoteDevices.userId))
    .where(
      and(eq(remoteDevices.tokenHash, hashToken(deviceToken)), isNull(remoteDevices.revokedAt)),
    )
    .limit(1);

  // One message for an unknown token, a revoked one, and a disabled account:
  // none of them should be distinguishable from outside.
  if (!device || !device.isActive) {
    return NextResponse.json({ error: "This device is no longer paired" }, { status: 401 });
  }

  const { token, hash } = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

  await db().insert(webSessions).values({
    userId: device.userId,
    tokenHash: hash,
    expiresAt,
    userAgent: req.headers.get("user-agent")?.slice(0, 500) ?? `device:${device.name}`,
  });

  await db()
    .update(remoteDevices)
    .set({ lastSeenAt: new Date() })
    .where(eq(remoteDevices.id, device.id));

  return NextResponse.json({
    token,
    expiresAt: expiresAt.toISOString(),
    user: {
      id: device.userId,
      name: device.userName,
      email: device.userEmail,
      role: device.userRole,
      preferredLanguage: device.preferredLanguage,
    },
    device: { id: device.id, name: device.name },
  });
}
