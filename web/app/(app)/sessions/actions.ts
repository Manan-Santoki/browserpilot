"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { audit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
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
