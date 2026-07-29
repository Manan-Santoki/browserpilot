"use server";

import { eq } from "drizzle-orm";
import { verifyPassword } from "@browserpilot/core";
import { users } from "@browserpilot/db";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { createSession } from "@/lib/session";

export type LoginState = { error?: string };

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) {
    return { error: "Enter your email and password." };
  }

  const [user] = await db().select().from(users).where(eq(users.email, email)).limit(1);

  // Hash even when the account is missing, so response time does not reveal
  // which emails exist. The message stays identical for the same reason.
  const ok = user ? await verifyPassword(password, user.passwordHash) : await burnTime(password);

  if (!user || !ok || !user.isActive) {
    await audit({
      action: "user.login_failed",
      actorUserId: user?.id ?? null,
      metadata: { email },
    });
    return { error: "That email and password combination is not recognised." };
  }

  await createSession(user.id);
  await audit({ action: "user.login", actorUserId: user.id });
  redirect("/");
}

/** Spends roughly the same time as a real verification against a dummy hash. */
async function burnTime(password: string): Promise<boolean> {
  const dummy =
    "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZQ$1Tk0K7HKbpQaUxvHo8sYbwCUcKgUqRLZlYcOtBk0PZM";
  await verifyPassword(password, dummy);
  return false;
}
