import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { robotSessions } from "@browserpilot/db";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";

/**
 * Why a session stopped. The live view asks for this when its socket closes,
 * so a session that ended while you were watching reads as an explanation
 * rather than a failed connection.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { id } = await params;

  const [session] = await db()
    .select({
      userId: robotSessions.userId,
      status: robotSessions.status,
      endedReason: robotSessions.endedReason,
    })
    .from(robotSessions)
    .where(eq(robotSessions.id, id))
    .limit(1);

  if (!session) return NextResponse.json({ error: "No such session" }, { status: 404 });
  if (user.role !== "ADMIN" && session.userId !== user.id) {
    return NextResponse.json({ error: "Not your session" }, { status: 403 });
  }

  return NextResponse.json({ status: session.status, endedReason: session.endedReason });
}
