import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { robotSessions } from "@browserpilot/db";
import { db } from "@/lib/db";
import { ticketFor, runtimeWsUrl } from "@/lib/runtime";
import { getCurrentUser } from "@/lib/session";

/**
 * Mint a short-lived WebSocket ticket for one session.
 *
 * Tickets expire in about a minute, so a page left open overnight asks for a
 * fresh one when it reconnects rather than holding a long-lived credential.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { id } = await params;

  const [session] = await db()
    .select({ userId: robotSessions.userId })
    .from(robotSessions)
    .where(eq(robotSessions.id, id))
    .limit(1);

  if (!session) return NextResponse.json({ error: "No such session" }, { status: 404 });
  if (user.role !== "ADMIN" && session.userId !== user.id) {
    return NextResponse.json({ error: "Not your session" }, { status: 403 });
  }

  const ticket = await ticketFor(user, id);
  return NextResponse.json({ url: runtimeWsUrl(id, ticket), ticket });
}
