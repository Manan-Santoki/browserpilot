import { desc, eq, inArray } from "drizzle-orm";
import { robotSessions, sessionEvents, siteProfiles } from "@browserpilot/db";
import { can, requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { FilesList, type SessionFiles } from "./files-list";

export default async function FilesPage() {
  const user = await requireUser();
  const seesAll = user.role === "ADMIN" || can(user, "session.view_others");

  // Which sessions may this person see?
  const sessions = await db()
    .select({
      id: robotSessions.id,
      title: robotSessions.title,
      startedAt: robotSessions.startedAt,
      siteName: siteProfiles.name,
    })
    .from(robotSessions)
    .leftJoin(siteProfiles, eq(siteProfiles.id, robotSessions.siteProfileId))
    .where(seesAll ? undefined : eq(robotSessions.userId, user.id))
    .orderBy(desc(robotSessions.startedAt))
    .limit(300);

  const byId = new Map(sessions.map((s) => [s.id, s]));
  const groups: SessionFiles[] = [];

  if (byId.size > 0) {
    const events = await db()
      .select({
        robotSessionId: sessionEvents.robotSessionId,
        payload: sessionEvents.payload,
        createdAt: sessionEvents.createdAt,
      })
      .from(sessionEvents)
      .where(inArray(sessionEvents.robotSessionId, [...byId.keys()]))
      .orderBy(desc(sessionEvents.createdAt));

    // Newest first, and one entry per filename per session: fetching the same
    // document twice replaced it in the store, so it is one file.
    const seen = new Set<string>();
    const collected = new Map<string, SessionFiles>();

    for (const event of events) {
      const payload = event.payload as { type?: string; filename?: string; url?: string };
      if (payload.type !== "file_ready" || !payload.filename || !payload.url) continue;

      const key = `${event.robotSessionId}:${payload.filename}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const session = byId.get(event.robotSessionId);
      if (!session) continue;

      let group = collected.get(event.robotSessionId);
      if (!group) {
        group = {
          sessionId: session.id,
          title: session.title ?? session.siteName ?? "Session",
          siteName: session.siteName,
          startedAt: session.startedAt.toISOString(),
          files: [],
        };
        collected.set(event.robotSessionId, group);
      }

      group.files.push({
        filename: payload.filename,
        url: payload.url,
        at: event.createdAt.toISOString(),
      });
    }

    groups.push(...collected.values());
  }

  const total = groups.reduce((sum, group) => sum + group.files.length, 0);

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Files</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          {total === 0
            ? "Everything the robot downloads is kept here."
            : `${total} file${total === 1 ? "" : "s"}${
                seesAll ? " across all users" : ""
              }, under the session that fetched them.`}
        </p>
      </div>

      {groups.length === 0 ? (
        <div className="rounded-lg border border-dashed px-6 py-16 text-center">
          <p className="text-muted-foreground text-sm">
            No downloads yet. Ask the robot to fetch a document and it will appear here.
          </p>
        </div>
      ) : (
        <FilesList groups={groups} />
      )}
    </div>
  );
}
