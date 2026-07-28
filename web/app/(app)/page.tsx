import Link from "next/link";
import { and, desc, eq, inArray } from "drizzle-orm";
import { robotSessions, siteAccounts, siteProfiles } from "@browserpilot/db";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { StartSessionForm } from "./start-form";
import { stopSession } from "./sessions/actions";

const LIVE = ["starting", "idle", "working", "awaiting_approval"] as const;

export default async function SessionsPage() {
  const user = await requireUser();
  const isAdmin = user.role === "ADMIN";

  const mine = isAdmin ? undefined : eq(robotSessions.userId, user.id);

  const live = await db()
    .select({
      id: robotSessions.id,
      status: robotSessions.status,
      title: robotSessions.title,
      startedAt: robotSessions.startedAt,
      siteName: siteProfiles.name,
    })
    .from(robotSessions)
    .leftJoin(siteProfiles, eq(siteProfiles.id, robotSessions.siteProfileId))
    .where(mine ? and(inArray(robotSessions.status, [...LIVE]), mine) : inArray(robotSessions.status, [...LIVE]))
    .orderBy(desc(robotSessions.startedAt));

  const recent = await db()
    .select({
      id: robotSessions.id,
      status: robotSessions.status,
      title: robotSessions.title,
      startedAt: robotSessions.startedAt,
      endedReason: robotSessions.endedReason,
      siteName: siteProfiles.name,
    })
    .from(robotSessions)
    .leftJoin(siteProfiles, eq(siteProfiles.id, robotSessions.siteProfileId))
    .where(mine)
    .orderBy(desc(robotSessions.startedAt))
    .limit(15);

  // Only sites this person actually has an identity on can be started.
  const startable = await db()
    .select({ id: siteProfiles.id, name: siteProfiles.name })
    .from(siteProfiles)
    .innerJoin(
      siteAccounts,
      and(eq(siteAccounts.siteProfileId, siteProfiles.id), eq(siteAccounts.userId, user.id)),
    )
    .where(eq(siteProfiles.isActive, true))
    .orderBy(siteProfiles.name);

  return (
    <div className="space-y-10">
      <div className="flex flex-wrap items-start justify-between gap-6">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Sessions</h1>
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            {live.length === 0
              ? "No browsers running."
              : `${live.length} browser${live.length === 1 ? "" : "s"} running${isAdmin ? " across all users" : ""}.`}
          </p>
        </div>

        <StartSessionForm sites={startable} />
      </div>

      {live.length > 0 ? (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {live.map((session) => (
            <li
              key={session.id}
              className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
            >
              <div className="flex items-center gap-2">
                <span
                  className={`inline-block h-2 w-2 rounded-full ${
                    session.status === "awaiting_approval"
                      ? "bg-amber-500"
                      : session.status === "working"
                        ? "animate-pulse bg-green-500"
                        : "bg-neutral-400"
                  }`}
                />
                <span className="text-sm text-neutral-500 dark:text-neutral-400">
                  {session.status === "awaiting_approval" ? "waiting for you" : session.status}
                </span>
              </div>

              <p className="mt-2 truncate font-medium">
                {session.title ?? session.siteName ?? "Session"}
              </p>
              <p className="text-sm text-neutral-500 dark:text-neutral-400">
                {session.siteName} · {new Date(session.startedAt).toLocaleTimeString()}
              </p>

              <div className="mt-4 flex items-center gap-3">
                <Link
                  href={`/sessions/${session.id}`}
                  className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
                >
                  Open
                </Link>
                <form action={stopSession}>
                  <input type="hidden" name="sessionId" value={session.id} />
                  <button
                    type="submit"
                    className="text-sm text-neutral-500 underline-offset-4 hover:underline dark:text-neutral-400"
                  >
                    Stop
                  </button>
                </form>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      <section>
        <h2 className="text-base font-medium">Recent</h2>
        {recent.length === 0 ? (
          <div className="mt-3 rounded-lg border border-dashed border-neutral-300 px-6 py-12 text-center dark:border-neutral-700">
            <p className="text-sm text-neutral-500 dark:text-neutral-400">
              {startable.length === 0
                ? "Register a site and add your account on it, then start a session."
                : "Nothing yet. Start a session to put a browser to work."}
            </p>
          </div>
        ) : (
          <ul className="mt-3 divide-y divide-neutral-200 rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
            {recent.map((session) => (
              <li key={session.id}>
                <Link
                  href={`/sessions/${session.id}`}
                  className="flex items-center gap-4 px-4 py-3 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-900"
                >
                  <span className="flex-1 truncate">
                    {session.title ?? session.siteName ?? "Session"}
                  </span>
                  <span className="hidden text-neutral-400 sm:inline">
                    {new Date(session.startedAt).toLocaleString()}
                  </span>
                  <span className="text-neutral-500 dark:text-neutral-400">{session.status}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
