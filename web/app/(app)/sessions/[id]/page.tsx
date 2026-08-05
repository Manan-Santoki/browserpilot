import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { robotSessions, siteProfiles, sessionShares, users } from "@browserpilot/db";
import { can, requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { runtimeHttpUrl } from "@/lib/runtime";
import { loadTranscript } from "@/lib/transcript";
import { canViewSession } from "@/lib/session-access";
import { restartBrowser, resumeSession, stopSession } from "../actions";
import { ConfirmAction } from "@/components/confirm-action";
import { Button } from "@/components/ui/button";
import { LiveSession } from "./live";
import { SessionFiles } from "./files";
import { TranscriptView } from "./transcript-view";
import { SharePanel } from "./share";

export default async function SessionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ resumeError?: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const { resumeError } = await searchParams;

  const [session] = await db()
    .select({
      id: robotSessions.id,
      userId: robotSessions.userId,
      status: robotSessions.status,
      title: robotSessions.title,
      startedAt: robotSessions.startedAt,
      endedReason: robotSessions.endedReason,
      resumedFromSessionId: robotSessions.resumedFromSessionId,
      siteName: siteProfiles.name,
      siteUrl: siteProfiles.baseUrl,
    })
    .from(robotSessions)
    .leftJoin(siteProfiles, eq(siteProfiles.id, robotSessions.siteProfileId))
    .where(eq(robotSessions.id, id))
    .limit(1);

  if (!session) notFound();
  if (!(await canViewSession(user, id))) notFound();

  const canControl = user.role === "ADMIN" || session.userId === user.id;

  const [owner] = session.userId === user.id
    ? []
    : await db()
        .select({ name: users.name })
        .from(users)
        .where(eq(users.id, session.userId))
        .limit(1);

  // Who this session is shared with, for the owner's share panel.
  const shares = canControl
    ? await db()
        .select({
          userId: sessionShares.userId,
          name: users.name,
          email: users.email,
          createdAt: sessionShares.createdAt,
        })
        .from(sessionShares)
        .innerJoin(users, eq(users.id, sessionShares.userId))
        .where(eq(sessionShares.robotSessionId, id))
        .orderBy(users.name)
    : [];

  const finished = ["stopped", "failed", "interrupted"].includes(session.status);
  const transcript = await loadTranscript(session.id);
  const [continuation] = await db()
    .select({ id: robotSessions.id, status: robotSessions.status })
    .from(robotSessions)
    .where(eq(robotSessions.resumedFromSessionId, session.id))
    .limit(1);

  return (
    <div className="flex flex-col gap-4 lg:h-full lg:min-h-0">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link
            href="/"
            className="text-muted-foreground hover:text-foreground text-sm transition-colors"
          >
            ← Sessions
          </Link>
          <h1 className="mt-2 text-xl font-semibold tracking-tight">
            {session.title ?? session.siteName ?? "Session"}
          </h1>
          <p className="text-muted-foreground mt-1 font-mono text-xs">
            {session.siteName ? `${session.siteName} · ` : ""}
            {session.siteUrl ?? ""} · {new Date(session.startedAt).toLocaleString()}
          </p>
        </div>

        {!finished && canControl ? (
          <div className="flex items-center gap-2">
            <SharePanel sessionId={session.id} shares={shares} />
            <ConfirmAction
              action={restartBrowser}
              fields={{ sessionId: session.id }}
              size="default"
              variant="outline"
              label="Restart browser"
              title="Restart the browser?"
              description="A fresh browser opens at the site's home page. The conversation so far is kept, but anything currently on screen — a half-filled form, an open record — is lost."
              confirmLabel="Restart it"
            />
            <ConfirmAction
              action={stopSession}
              fields={{ sessionId: session.id }}
              size="default"
              variant="outline"
              label="Stop session"
              title="Stop this session?"
              description="The browser closes where it is. The conversation and files stay available, and you can later continue in a fresh browser."
              confirmLabel="Stop it"
              destructive
            />
          </div>
        ) : !finished && canControl === false ? (
          <p className="text-muted-foreground text-sm">Read-only — you are watching this session.</p>
        ) : finished && canControl ? (
          continuation ? (
            <Link href={`/sessions/${continuation.id}`} className="text-sm font-medium underline">
              Open continuation
            </Link>
          ) : (
            <form action={resumeSession}>
              <input type="hidden" name="sessionId" value={session.id} />
              <Button type="submit">Resume session</Button>
            </form>
          )
        ) : null}
      </div>

      {!canControl && owner ? (
        <div className="border-signal/40 bg-signal/5 text-foreground/90 rounded-lg border px-4 py-3 text-sm">
          You are watching {owner.name}&apos;s session. You can read the conversation and watch the
          browser, but not drive it.
        </div>
      ) : null}

      {session.resumedFromSessionId ? (
        <p className="text-muted-foreground text-sm">
          Continued from{" "}
          <Link className="text-foreground underline" href={`/sessions/${session.resumedFromSessionId}`}>
            the previous session
          </Link>
          .
        </p>
      ) : null}

      {resumeError ? (
        <div className="border-destructive/50 text-destructive rounded-lg border px-4 py-3 text-sm">
          {resumeError}
        </div>
      ) : null}

      {/* Downloads outlive the live view: still listed after a session ends. */}
      <SessionFiles sessionId={session.id} />

      {finished ? (
        <div className="space-y-4">
          <div className="rounded-lg border px-4 py-3 text-sm">
            <span className="text-foreground/90">
              This session has ended{session.endedReason ? `: ${session.endedReason}` : "."}
            </span>{" "}
            <span className="text-muted-foreground">
              Its browser is gone, but the conversation and files below are kept.
              {continuation
                ? " Work continues in the linked session."
                : " Resume opens a fresh browser at the last safe page and hands off the recent context."}
            </span>
          </div>
          <TranscriptView items={transcript} />
        </div>
      ) : (
        <LiveSession
          sessionId={session.id}
          runtimeHttpUrl={runtimeHttpUrl()}
          language={user.preferredLanguage}
          initialItems={transcript}
          readOnly={!canControl}
          ownerName={!canControl ? (owner?.name ?? "someone else") : undefined}
        />
      )}
    </div>
  );
}
