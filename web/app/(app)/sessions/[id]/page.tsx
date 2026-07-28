import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { robotSessions, siteProfiles } from "@browserpilot/db";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { runtimeHttpUrl } from "@/lib/runtime";
import { stopSession } from "../actions";
import { LiveSession } from "./live";

export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;

  const [session] = await db()
    .select({
      id: robotSessions.id,
      userId: robotSessions.userId,
      status: robotSessions.status,
      title: robotSessions.title,
      startedAt: robotSessions.startedAt,
      endedReason: robotSessions.endedReason,
      siteName: siteProfiles.name,
      siteUrl: siteProfiles.baseUrl,
    })
    .from(robotSessions)
    .leftJoin(siteProfiles, eq(siteProfiles.id, robotSessions.siteProfileId))
    .where(eq(robotSessions.id, id))
    .limit(1);

  if (!session) notFound();
  if (user.role !== "ADMIN" && session.userId !== user.id) notFound();

  const finished = ["stopped", "failed", "interrupted"].includes(session.status);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link
            href="/"
            className="text-sm text-neutral-500 underline-offset-4 hover:underline dark:text-neutral-400"
          >
            ← Sessions
          </Link>
          <h1 className="mt-2 text-xl font-semibold tracking-tight">
            {session.title ?? session.siteName ?? "Session"}
          </h1>
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            {session.siteName ? `${session.siteName} · ` : ""}
            {session.siteUrl ?? ""} · started{" "}
            {new Date(session.startedAt).toLocaleString()}
          </p>
        </div>

        {!finished ? (
          <form action={stopSession}>
            <input type="hidden" name="sessionId" value={session.id} />
            <button
              type="submit"
              className="rounded-md border border-neutral-300 px-3 py-2 text-sm font-medium hover:bg-neutral-50 dark:border-neutral-600 dark:hover:bg-neutral-900"
            >
              Stop session
            </button>
          </form>
        ) : null}
      </div>

      {finished ? (
        <div className="rounded-lg border border-neutral-200 px-6 py-10 text-center dark:border-neutral-800">
          <p className="text-sm text-neutral-600 dark:text-neutral-300">
            This session has ended{session.endedReason ? `: ${session.endedReason}` : "."}
          </p>
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            Its browser is gone, so there is nothing left to watch or talk to.
          </p>
        </div>
      ) : (
        <LiveSession sessionId={session.id} runtimeHttpUrl={runtimeHttpUrl()} />
      )}
    </div>
  );
}
