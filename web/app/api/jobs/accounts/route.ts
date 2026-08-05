import { and, desc, eq } from "drizzle-orm";
import { jobConnections, jobPortalAccounts } from "@browserpilot/db";
import { can } from "@/lib/auth";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";

const mask = (value: string) => value.includes("@")
  ? `${value.slice(0, 2)}•••@${value.split("@")[1]}`
  : `${value.slice(0, 2)}••••`;

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  if (!can(user, "job.apply")) return Response.json({ error: "Forbidden" }, { status: 403 });
  const [[gmail], accounts] = await Promise.all([
    db().select({ email: jobConnections.accountEmail, state: jobConnections.state, scope: jobConnections.scope, updatedAt: jobConnections.updatedAt })
      .from(jobConnections).where(and(eq(jobConnections.userId, user.id), eq(jobConnections.kind, "gmail"))).limit(1),
    db().select({
      id: jobPortalAccounts.id,
      portalLabel: jobPortalAccounts.portalLabel,
      portalOrigin: jobPortalAccounts.portalOrigin,
      username: jobPortalAccounts.username,
      status: jobPortalAccounts.status,
      verificationStatus: jobPortalAccounts.verificationStatus,
      lastUsedAt: jobPortalAccounts.lastUsedAt,
      createdAt: jobPortalAccounts.createdAt,
    }).from(jobPortalAccounts).where(eq(jobPortalAccounts.userId, user.id)).orderBy(desc(jobPortalAccounts.lastUsedAt)),
  ]);
  return Response.json({
    gmail: gmail ? { ...gmail, email: mask(gmail.email) } : null,
    accounts: accounts.map((account) => ({ ...account, username: mask(account.username) })),
  }, { headers: { "cache-control": "private, no-store" } });
}
