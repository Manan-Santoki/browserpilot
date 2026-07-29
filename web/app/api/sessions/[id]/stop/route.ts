import { NextResponse } from "next/server";
import { audit } from "@/lib/audit";
import { stopRuntimeSession } from "@/lib/runtime";
import { getCurrentUser } from "@/lib/session";

/** Stop a browser. The runtime checks ownership; this only proves who is asking. */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { id } = await params;
  const result = await stopRuntimeSession(user, id);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  await audit({
    actorUserId: user.id,
    action: "session.stopped",
    targetType: "session",
    targetId: id,
  });

  return NextResponse.json({ ok: true });
}
