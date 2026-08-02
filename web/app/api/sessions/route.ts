import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { robotSessions, siteProfiles } from "@browserpilot/db";
import { audit } from "@/lib/audit";
import { can } from "@/lib/auth";
import { db } from "@/lib/db";
import { listRuntimeSessions, startRuntimeSession } from "@/lib/runtime";
import { getCurrentUser } from "@/lib/session";

const LIVE = ["starting", "idle", "working", "awaiting_approval"] as const;

/**
 * Sessions this person can see: the live ones from the runtime, which knows
 * their true state, and recent history from the database, which outlives it.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const live = await listRuntimeSessions(user);

  const recent = await db()
    .select({
      id: robotSessions.id,
      title: robotSessions.title,
      status: robotSessions.status,
      startedAt: robotSessions.startedAt,
      endedReason: robotSessions.endedReason,
      siteName: siteProfiles.name,
    })
    .from(robotSessions)
    .leftJoin(siteProfiles, eq(siteProfiles.id, robotSessions.siteProfileId))
    .where(user.role === "ADMIN" || can(user, "session.view_others")
      ? undefined
      : eq(robotSessions.userId, user.id))
    .orderBy(desc(robotSessions.startedAt))
    .limit(40);

  const liveIds = new Set(live.ok ? live.data.sessions.map((s) => s.id) : []);

  return NextResponse.json({
    sessions: recent.map((row) => {
      const claimsLive = (LIVE as readonly string[]).includes(row.status);
      const reallyLive = liveIds.has(row.id);

      return {
        ...row,
        startedAt: row.startedAt.toISOString(),
        live: reallyLive,
        // The runtime is the authority on whether a browser is really running.
        // A row can still say "working" after the process holding it has gone,
        // and showing that as live sends someone to an empty session. Only
        // correct it when the runtime answered — if it is unreachable, its
        // silence is not evidence that nothing is running.
        status: claimsLive && !reallyLive && live.ok ? "interrupted" : row.status,
      };
    }),
    runtimeReachable: live.ok,
  });
}

/** Start a browser. */
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as {
    siteProfileId?: string;
    title?: string;
    model?: string;
  };
  if (!body.siteProfileId) {
    return NextResponse.json({ error: "Choose a site first" }, { status: 400 });
  }

  if (!can(user, "session.start")) {
    return NextResponse.json({ error: "You do not have permission to start sessions" }, { status: 403 });
  }

  const result = await startRuntimeSession(user, body.siteProfileId, body.title, body.model);
  if (!result.ok) {
    return NextResponse.json({ error: result.error, code: result.code }, { status: result.status });
  }

  await audit({
    actorUserId: user.id,
    action: "session.started",
    targetType: "session",
    targetId: result.data.id,
    metadata: { siteProfileId: body.siteProfileId, from: "app" },
  });

  return NextResponse.json({ id: result.data.id });
}
