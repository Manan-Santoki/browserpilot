import Link from "next/link";
import { desc, eq, inArray } from "drizzle-orm";
import { robotSessions, sessionEvents, siteProfiles } from "@browserpilot/db";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";

type FileRow = {
  filename: string;
  url: string;
  sessionId: string;
  sessionTitle: string | null;
  siteName: string | null;
  at: Date;
};

export default async function FilesPage() {
  const user = await requireUser();
  const isAdmin = user.role === "ADMIN";

  // Which sessions may this person see?
  const sessions = await db()
    .select({
      id: robotSessions.id,
      title: robotSessions.title,
      siteName: siteProfiles.name,
    })
    .from(robotSessions)
    .leftJoin(siteProfiles, eq(siteProfiles.id, robotSessions.siteProfileId))
    .where(isAdmin ? undefined : eq(robotSessions.userId, user.id))
    .orderBy(desc(robotSessions.startedAt))
    .limit(300);

  const byId = new Map(sessions.map((s) => [s.id, s]));
  const files: FileRow[] = [];

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

    // Same filename downloaded twice in one session is one entry, newest first.
    const seen = new Set<string>();
    for (const event of events) {
      const payload = event.payload as { type?: string; filename?: string; url?: string };
      if (payload.type !== "file_ready" || !payload.filename || !payload.url) continue;

      const key = `${event.robotSessionId}:${payload.filename}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const session = byId.get(event.robotSessionId);
      files.push({
        filename: payload.filename,
        url: payload.url,
        sessionId: event.robotSessionId,
        sessionTitle: session?.title ?? null,
        siteName: session?.siteName ?? null,
        at: event.createdAt,
      });
    }
  }

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Files</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Everything the robot has downloaded{isAdmin ? " across all users" : ""}. Files stay
          available after their session ends.
        </p>
      </div>

      {files.length === 0 ? (
        <div className="rounded-lg border border-dashed px-6 py-16 text-center">
          <p className="text-sm text-muted-foreground">
            No downloads yet. Ask the robot to fetch a document and it will appear here.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-lg border">
          {files.map((file) => (
            <li
              key={`${file.sessionId}:${file.filename}`}
              className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm"
            >
              <a
                href={file.url}
                className="min-w-0 flex-1 truncate font-medium underline-offset-4 hover:underline"
              >
                ⬇ {file.filename}
              </a>

              <Link
                href={`/sessions/${file.sessionId}`}
                className="text-muted-foreground hover:text-foreground truncate transition-colors"
              >
                {file.sessionTitle ?? file.siteName ?? "session"}
              </Link>

              <span className="whitespace-nowrap text-xs text-muted-foreground">
                {new Date(file.at).toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
