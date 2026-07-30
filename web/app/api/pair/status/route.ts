import { NextResponse } from "next/server";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import { hashToken } from "@browserpilot/core";
import { pairingCodes, remoteDevices } from "@browserpilot/db";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";

const CODE_PATTERN = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/;
const DEVICE_MATCH_WINDOW_MS = 5_000;

/**
 * Lets the page that displayed a pairing code notice when the phone redeems
 * it. The code is scoped to the signed-in user, so knowing somebody else's
 * short-lived code does not reveal whether they have paired a device.
 */
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const code = new URL(req.url).searchParams.get("code")?.trim().toUpperCase() ?? "";
  if (!CODE_PATTERN.test(code)) {
    return NextResponse.json({ status: "expired" });
  }

  const [pairing] = await db()
    .select({
      claimedAt: pairingCodes.claimedAt,
      expiresAt: pairingCodes.expiresAt,
    })
    .from(pairingCodes)
    .where(
      and(eq(pairingCodes.userId, user.id), eq(pairingCodes.codeHash, hashToken(code))),
    )
    .limit(1);

  if (!pairing || pairing.expiresAt <= new Date()) {
    return NextResponse.json({ status: "expired" });
  }

  if (!pairing.claimedAt) {
    return NextResponse.json({ status: "pending" });
  }

  // Creating a replacement code also closes the previous one. A real claim is
  // distinguishable because /api/pair creates the device immediately before
  // marking the code claimed.
  const claimedAt = pairing.claimedAt.getTime();
  const [device] = await db()
    .select({ name: remoteDevices.name })
    .from(remoteDevices)
    .where(
      and(
        eq(remoteDevices.userId, user.id),
        gte(remoteDevices.createdAt, new Date(claimedAt - DEVICE_MATCH_WINDOW_MS)),
        lte(remoteDevices.createdAt, new Date(claimedAt + DEVICE_MATCH_WINDOW_MS)),
      ),
    )
    .orderBy(desc(remoteDevices.createdAt))
    .limit(1);

  if (!device) {
    return NextResponse.json({ status: "expired" });
  }

  return NextResponse.json({ status: "connected", deviceName: device.name });
}
