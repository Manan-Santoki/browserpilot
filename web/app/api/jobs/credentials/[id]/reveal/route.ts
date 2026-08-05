import { and, eq } from "drizzle-orm";
import { decryptSecret, verifyPassword } from "@browserpilot/core";
import { jobPortalAccounts, users } from "@browserpilot/db";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";

const globalRate = globalThis as typeof globalThis & { jobRevealAttempts?: Map<string, number[]> };
const attempts = globalRate.jobRevealAttempts ??= new Map();

export async function POST(request: Request, context: RouteContext<"/api/jobs/credentials/[id]/reveal">) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  if (user.role !== "ADMIN" && !user.perms.includes("job.apply")) return Response.json({ error: "Forbidden" }, { status: 403 });
  const now = Date.now();
  const recent: number[] = (attempts.get(user.id) ?? []).filter((time: number) => now - time < 60_000);
  if (recent.length >= 5) return Response.json({ error: "Too many reveal attempts. Try again in a minute." }, { status: 429, headers: { "cache-control": "no-store" } });
  recent.push(now); attempts.set(user.id, recent);
  const body = await request.json().catch(() => ({})) as { password?: string };
  const [account] = await db().select({ id: jobPortalAccounts.id, passwordEncrypted: jobPortalAccounts.passwordEncrypted, passwordHash: users.passwordHash })
    .from(jobPortalAccounts).innerJoin(users, eq(users.id, jobPortalAccounts.userId))
    .where(and(eq(jobPortalAccounts.id, (await context.params).id), eq(jobPortalAccounts.userId, user.id))).limit(1);
  if (!account || !body.password || !(await verifyPassword(body.password, account.passwordHash))) {
    return Response.json({ error: "Current password was not accepted" }, { status: 403, headers: { "cache-control": "no-store" } });
  }
  await audit({ actorUserId: user.id, action: "job.credential_revealed", targetType: "job_portal_account", targetId: account.id });
  return Response.json({ password: decryptSecret(account.passwordEncrypted, process.env.BP_MASTER_KEY ?? "") }, {
    headers: { "cache-control": "no-store, max-age=0", pragma: "no-cache" },
  });
}
