"use server";

import { redirect } from "next/navigation";
import { audit } from "@/lib/audit";
import { destroySession } from "@/lib/session";
import { getCurrentUser } from "@/lib/session";

export async function logout(): Promise<void> {
  const user = await getCurrentUser();
  await destroySession();
  if (user) await audit({ action: "user.logout", actorUserId: user.id });
  redirect("/login");
}
