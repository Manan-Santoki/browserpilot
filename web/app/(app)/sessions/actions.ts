"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { audit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { startRuntimeSession, stopRuntimeSession } from "@/lib/runtime";

export type StartState = { error?: string };

export async function startSession(_prev: StartState, formData: FormData): Promise<StartState> {
  const user = await requireUser();

  const siteProfileId = String(formData.get("siteProfileId") ?? "");
  const title = String(formData.get("title") ?? "").trim();
  if (!siteProfileId) return { error: "Choose a site first." };

  const result = await startRuntimeSession(user, siteProfileId, title || undefined);
  if (!result.ok) return { error: result.error };

  await audit({
    actorUserId: user.id,
    action: "session.started",
    targetType: "session",
    targetId: result.data.id,
    metadata: { siteProfileId },
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
