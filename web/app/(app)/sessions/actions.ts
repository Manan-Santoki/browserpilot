"use server";

import { redirect } from "next/navigation";
import { and, eq, ne } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { audit } from "@/lib/audit";
import { can, requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { robotSessions, sessionShares, users } from "@browserpilot/db";
import {
  restartRuntimeBrowser,
  resumeRuntimeSession,
  startRuntimeSession,
  stopRuntimeSession,
} from "@/lib/runtime";

export type StartState = {
  error?: string;
  /** Set when the fix is a sign-in, so the form can link straight to it. */
  signInSiteId?: string;
};

export async function startSession(_prev: StartState, formData: FormData): Promise<StartState> {
  const user = await requireUser();

  if (!can(user, "session.start")) {
    return { error: "You do not have permission to start sessions." };
  }

  const siteProfileId = String(formData.get("siteProfileId") ?? "");
  const title = String(formData.get("title") ?? "").trim();
  const chosen = String(formData.get("model") ?? "").trim();
  const model = chosen === "default" ? "" : chosen;
  if (!siteProfileId) return { error: "Choose a site first." };

  const result = await startRuntimeSession(
    user,
    siteProfileId,
    title || undefined,
    model || undefined,
  );
  if (!result.ok) {
    return {
      error: result.error,
      signInSiteId:
        result.code === "not_linked" || result.code === "login_expired"
          ? siteProfileId
          : undefined,
    };
  }

  await audit({
    actorUserId: user.id,
    action: "session.started",
    targetType: "session",
    targetId: result.data.id,
    metadata: { siteProfileId, model: model || "default" },
  });

  redirect(`/sessions/${result.data.id}`);
}

export async function stopSession(formData: FormData): Promise<void> {
  const user = await requireUser();
  const sessionId = String(formData.get("sessionId") ?? "");
  if (!sessionId) return;

  const result = await stopRuntimeSession(user, sessionId);
  if (result.ok) {
    await audit({
      actorUserId: user.id,
      action: "session.stopped",
      targetType: "session",
      targetId: sessionId,
    });
  }

  revalidatePath("/");
  revalidatePath(`/sessions/${sessionId}`);
}

export async function restartBrowser(formData: FormData): Promise<void> {
  const user = await requireUser();
  const sessionId = String(formData.get("sessionId") ?? "");
  if (!sessionId) return;

  await restartRuntimeBrowser(user, sessionId);
  revalidatePath(`/sessions/${sessionId}`);
}

export async function resumeSession(formData: FormData): Promise<void> {
  const user = await requireUser();
  const sourceSessionId = String(formData.get("sessionId") ?? "");
  if (!sourceSessionId) return;

  const result = await resumeRuntimeSession(user, sourceSessionId);
  if (!result.ok) {
    redirect(`/sessions/${sourceSessionId}?resumeError=${encodeURIComponent(result.error)}`);
  }

  await audit({
    actorUserId: user.id,
    action: "session.resumed",
    targetType: "session",
    targetId: result.data.id,
    metadata: { resumedFromSessionId: sourceSessionId, from: "web" },
  });

  redirect(`/sessions/${result.data.id}`);
}

export type ShareState = { error?: string; success?: string };

/**
 * Only the owner (or an admin) can share a session. The grantee gets read
 * access — watching the browser and reading the conversation, never driving it.
 */
export async function shareSession(_prev: ShareState, formData: FormData): Promise<ShareState> {
  const user = await requireUser();
  const sessionId = String(formData.get("sessionId") ?? "");
  const email = String(formData.get("email") ?? "").trim().toLowerCase();

  if (!sessionId || !email.includes("@")) return { error: "Enter the person's email address." };

  const [session] = await db()
    .select({ userId: robotSessions.userId })
    .from(robotSessions)
    .where(eq(robotSessions.id, sessionId))
    .limit(1);
  if (!session) return { error: "No such session." };
  if (user.role !== "ADMIN" && session.userId !== user.id) {
    return { error: "Only the owner can share this session." };
  }

  const [target] = await db()
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (!target) return { error: "No account has that email." };
  if (target.id === session.userId) return { error: "This is already the owner's session." };

  try {
    await db()
      .insert(sessionShares)
      .values({ robotSessionId: sessionId, userId: target.id, grantedById: user.id })
      .onConflictDoNothing();
  } catch {
    return { error: "Could not share the session. Please try again." };
  }

  await audit({
    actorUserId: user.id,
    action: "session.shared",
    targetType: "session",
    targetId: sessionId,
    metadata: { sharedWith: email, sharedWithUserId: target.id },
  });

  revalidatePath(`/sessions/${sessionId}`);
  return { success: `Shared with ${target.name ?? email}.` };
}

export async function unshareSession(formData: FormData): Promise<void> {
  const user = await requireUser();
  const sessionId = String(formData.get("sessionId") ?? "");
  const userId = String(formData.get("userId") ?? "");
  if (!sessionId || !userId) return;

  const [session] = await db()
    .select({ userId: robotSessions.userId })
    .from(robotSessions)
    .where(eq(robotSessions.id, sessionId))
    .limit(1);
  if (!session) return;
  if (user.role !== "ADMIN" && session.userId !== user.id) return;

  await db()
    .delete(sessionShares)
    .where(
      and(eq(sessionShares.robotSessionId, sessionId), eq(sessionShares.userId, userId)),
    );

  await audit({
    actorUserId: user.id,
    action: "session.shared",
    targetType: "session",
    targetId: sessionId,
    metadata: { unsharedUserId: userId },
  });

  revalidatePath(`/sessions/${sessionId}`);
}
