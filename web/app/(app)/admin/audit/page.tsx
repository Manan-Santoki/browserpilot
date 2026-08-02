import { desc, eq } from "drizzle-orm";
import { auditLogs, users } from "@browserpilot/db";
import { requirePermission } from "@/lib/auth";
import { db } from "@/lib/db";
import { AdminHeader } from "../shell";
import { AuditList } from "./audit-list";

export default async function AuditPage() {
  await requirePermission("audit.view");

  const entries = await db()
    .select({
      id: auditLogs.id,
      action: auditLogs.action,
      createdAt: auditLogs.createdAt,
      metadata: auditLogs.metadata,
      actorName: users.name,
      actorEmail: users.email,
    })
    .from(auditLogs)
    .leftJoin(users, eq(users.id, auditLogs.actorUserId))
    .orderBy(desc(auditLogs.createdAt))
    .limit(200);

  return (
    <>
      <AdminHeader
        title="Audit log"
        description={`The ${entries.length} most recent events. Filter by type, or by who did it.`}
      />
      <AuditList entries={entries} />
    </>
  );
}
