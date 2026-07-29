import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { robotSessions, siteProfiles } from "@browserpilot/db";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { runtimeHttpUrl } from "@/lib/runtime";
import { loadTranscript } from "@/lib/transcript";
import { restartBrowser, stopSession } from "../actions";
import { ConfirmAction } from "@/components/confirm-action";
import { LiveSession } from "./live";
import { SessionFiles } from "./files";
import { TranscriptView } from "./transcript-view";

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
  const transcript = await loadTranscript(session.id);

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

        {!finished ? (
          <div className="flex items-center gap-2">
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
              description="The browser closes and the robot stops where it is. The conversation and any downloaded files stay available, but you cannot pick this session back up."
              confirmLabel="Stop it"
              destructive
            />
          </div>
        ) : null}
      </div>

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
        />
      )}
    </div>
  );
}
