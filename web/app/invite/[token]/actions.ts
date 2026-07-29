"use server";

import { and, eq, gt, isNull } from "drizzle-orm";
import { redirect } from "next/navigation";
import { hashPassword, hashToken } from "@browserpilot/core";
import { invites, users } from "@browserpilot/db";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { createSession } from "@/lib/session";

export type AcceptState = { error?: string };

export async function acceptInvite(_prev: AcceptState, formData: FormData): Promise<AcceptState> {
  const token = String(formData.get("token") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  if (!name) return { error: "Enter your name." };
  if (password.length < 12) return { error: "Choose a password of at least 12 characters." };
  if (password !== confirm) return { error: "The two passwords do not match." };

  const [invite] = await db()
    .select()
    .from(invites)
    .where(
      and(
        eq(invites.tokenHash, hashToken(token)),
        gt(invites.expiresAt, new Date()),
        isNull(invites.acceptedAt),
      ),
    )
    .limit(1);

  if (!invite) return { error: "This invitation is invalid, already used, or expired." };

  // Between the invite being issued and accepted, someone may have created the
  // account another way.
  const [existing] = await db()
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, invite.email))
    .limit(1);
  if (existing) return { error: "An account with that email already exists. Try signing in." };

  const [created] = await db()
    .insert(users)
    .values({
      email: invite.email,
      name,
      passwordHash: await hashPassword(password),
      role: invite.role,
    })
    .returning({ id: users.id });

  await db().update(invites).set({ acceptedAt: new Date() }).where(eq(invites.id, invite.id));

  await createSession(created!.id);
  await audit({
    actorUserId: created!.id,
    action: "user.invite_accepted",
    targetType: "user",
    targetId: created!.id,
  });

  redirect("/");
}
