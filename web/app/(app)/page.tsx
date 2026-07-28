import { desc, eq } from "drizzle-orm";
import { robotSessions, siteProfiles } from "@browserpilot/db";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";

export default async function SessionsPage() {
  const user = await requireUser();

  // Admins oversee every session; everyone else sees only their own.
  const rows = await db()
    .select({
      id: robotSessions.id,
      status: robotSessions.status,
      title: robotSessions.title,
      startedAt: robotSessions.startedAt,
      siteName: siteProfiles.name,
    })
    .from(robotSessions)
    .leftJoin(siteProfiles, eq(siteProfiles.id, robotSessions.siteProfileId))
    .where(user.role === "ADMIN" ? undefined : eq(robotSessions.userId, user.id))
    .orderBy(desc(robotSessions.startedAt))
    .limit(50);

  const live = rows.filter((r) =>
    ["starting", "idle", "working", "awaiting_approval"].includes(r.status),
  );

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Sessions</h1>
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            {live.length === 0
              ? "No browsers running."
              : `${live.length} browser${live.length === 1 ? "" : "s"} running.`}
          </p>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-300 px-6 py-16 text-center dark:border-neutral-700">
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            Nothing here yet. Register a site, then start a session to put a browser to work.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-neutral-200 rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
          {rows.map((session) => (
            <li key={session.id} className="flex items-center gap-4 px-4 py-3 text-sm">
              <span className="font-mono text-xs text-neutral-400">
                {session.id.slice(0, 8)}
              </span>
              <span className="flex-1 truncate">{session.title ?? session.siteName ?? "—"}</span>
              <span className="text-neutral-500 dark:text-neutral-400">{session.status}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
