import Link from "next/link";
import { and, desc, eq, inArray } from "drizzle-orm";
import { robotSessions, siteAccounts, siteProfiles } from "@browserpilot/db";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { StatusLabel } from "@/components/status-lamp";
import { StartSessionForm } from "./start-form";
import { stopSession } from "./sessions/actions";
import { ConfirmAction } from "@/components/confirm-action";
import { SessionThumbnail } from "@/components/session-thumbnail";
import { listRuntimeSessions } from "@/lib/runtime";
import { availableModels } from "@/lib/models";

const LIVE = ["starting", "idle", "working", "awaiting_approval"] as const;

function elapsed(from: Date): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(from).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

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
    .where(
      mine
        ? and(inArray(robotSessions.status, [...LIVE]), mine)
        : inArray(robotSessions.status, [...LIVE]),
    )
    .orderBy(desc(robotSessions.startedAt));

  const recent = await db()
    .select({
      id: robotSessions.id,
      status: robotSessions.status,
      title: robotSessions.title,
      startedAt: robotSessions.startedAt,
      siteName: siteProfiles.name,
    })
    .from(robotSessions)
    .leftJoin(siteProfiles, eq(siteProfiles.id, robotSessions.siteProfileId))
    .where(mine)
    .orderBy(desc(robotSessions.startedAt))
    .limit(12);

  const startable = await db()
    .select({ id: siteProfiles.id, name: siteProfiles.name })
    .from(siteProfiles)
    .innerJoin(
      siteAccounts,
      and(eq(siteAccounts.siteProfileId, siteProfiles.id), eq(siteAccounts.userId, user.id)),
    )
    .where(eq(siteProfiles.isActive, true))
    .orderBy(siteProfiles.name);

  const runtime = await listRuntimeSessions(user);
  const runtimeById = new Map(
    runtime.ok ? runtime.data.sessions.map((session) => [session.id, session]) : [],
  );
  const connectedLive = live
    .filter((session) => !runtime.ok || runtimeById.has(session.id))
    .map((session) => {
      const running = runtimeById.get(session.id);
      return {
        ...session,
        status: running?.status ?? session.status,
        connected: Boolean(running),
      };
    });

  const needsYou = connectedLive.filter((s) => s.status === "awaiting_approval").length;

  return (
    <div className="mx-auto w-full max-w-6xl space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Sessions</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {connectedLive.length === 0 ? (
              "Nothing running."
            ) : needsYou > 0 ? (
              <>
                <span className="text-signal">
                  {needsYou} waiting for you
                </span>{" "}
                · {connectedLive.length} running{isAdmin ? " across all users" : ""}.
              </>
            ) : (
              `${connectedLive.length} running${isAdmin ? " across all users" : ""}.`
            )}
          </p>
        </div>

        <StartSessionForm sites={startable} models={await availableModels()} />
      </div>

      {connectedLive.length > 0 ? (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {connectedLive.map((session) => (
            <li key={session.id}>
              <Card
                className={
                  session.status === "awaiting_approval" ? "border-signal/40 py-0" : "py-0"
                }
              >
                <CardContent className="p-4">
                  <div className="flex items-center justify-between gap-2">
                    <StatusLabel status={session.status} live={session.connected} />
                    <span className="text-muted-foreground tabular font-mono text-xs">
                      {elapsed(session.startedAt)}
                    </span>
                  </div>

                  {session.connected ? <SessionThumbnail sessionId={session.id} /> : null}

                  <p className="mt-3 truncate font-medium">
                    {session.title ?? session.siteName ?? "Session"}
                  </p>
                  <p className="text-muted-foreground truncate font-mono text-xs">
                    {session.siteName ?? "—"}
                  </p>

                  <div className="mt-4 flex items-center gap-2">
                    <Link
                      href={`/sessions/${session.id}`}
                      className={buttonVariants({ size: "sm" })}
                    >
                      Open
                    </Link>
                    <ConfirmAction
                      action={stopSession}
                      fields={{ sessionId: session.id }}
                      label="Stop"
                      title="Stop this session?"
                      description="The browser closes and the robot stops where it is. The conversation and any downloaded files stay available, but you cannot pick this session back up."
                      confirmLabel="Stop it"
                      destructive
                    />
                  </div>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      ) : null}

      <section>
        <h2 className="text-muted-foreground font-mono text-xs tracking-wider uppercase">
          Recent
        </h2>

        {recent.length === 0 ? (
          <Card className="mt-3">
            <CardContent className="py-12 text-center">
              <p className="text-muted-foreground text-sm">
                {startable.length === 0
                  ? "Register a site and add your account on it, then start a session."
                  : "Nothing yet. Start a session to put a browser to work."}
              </p>
            </CardContent>
          </Card>
        ) : (
          <Card className="mt-3 py-0">
            <ul className="divide-y">
              {recent.map((session) => (
                <li key={session.id}>
                  <Link
                    href={`/sessions/${session.id}`}
                    className="hover:bg-accent/50 flex items-center gap-4 px-4 py-3 text-sm transition-colors"
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {session.title ?? session.siteName ?? "Session"}
                    </span>
                    <span className="text-muted-foreground hidden font-mono text-xs sm:inline">
                      {new Date(session.startedAt).toLocaleString()}
                    </span>
                    <StatusLabel status={session.status} className="text-xs" />
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </section>
    </div>
  );
}
