import { NextResponse } from "next/server";
import { audit } from "@/lib/audit";
import { resumeRuntimeSession } from "@/lib/runtime";
import { getCurrentUser } from "@/lib/session";

/** Create a linked continuation. Ownership and terminal state are checked by the runtime. */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { id } = await params;
  const result = await resumeRuntimeSession(user, id);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, code: result.code },
      { status: result.status },
    );
  }

  await audit({
    actorUserId: user.id,
    action: "session.resumed",
    targetType: "session",
    targetId: result.data.id,
    metadata: { resumedFromSessionId: id, from: "app" },
  });

  return NextResponse.json(result.data);
}
