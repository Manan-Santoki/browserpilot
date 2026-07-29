import { desc, eq } from "drizzle-orm";
import { auditLogs, users } from "@browserpilot/db";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";

/** Plain-language phrasing beats raw action keys for anyone scanning this. */
const PHRASING: Record<string, string> = {
  "user.login": "signed in",
  "user.login_failed": "failed to sign in",
  "user.logout": "signed out",
  "user.invited": "invited someone",
  "user.invite_accepted": "accepted an invitation",
  "user.updated": "changed a user",
  "site.created": "registered a site",
  "site.updated": "updated a site",
  "site.deleted": "removed a site",
  "session.started": "started a session",
  "session.stopped": "stopped a session",
  "session.approval": "answered an approval",
  "device.paired": "paired a device",
  "device.revoked": "revoked a device",
  "settings.updated": "changed the limits",
};

export default async function AuditPage() {
  await requireAdmin();

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
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Audit log</h1>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          The 200 most recent events.
        </p>
      </div>

      {entries.length === 0 ? (
        <p className="text-sm text-neutral-500">Nothing recorded yet.</p>
      ) : (
        <ul className="divide-y divide-neutral-200 rounded-lg border border-neutral-200 text-sm dark:divide-neutral-800 dark:border-neutral-800">
          {entries.map((entry) => (
            <li key={entry.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 px-4 py-2.5">
              <span className="font-medium">{entry.actorName ?? "Someone"}</span>
              <span className="text-neutral-600 dark:text-neutral-300">
                {PHRASING[entry.action] ?? entry.action}
              </span>
              {entry.metadata ? (
                <span className="truncate text-xs text-neutral-400">
                  {Object.entries(entry.metadata as Record<string, unknown>)
                    .map(([k, v]) => `${k}: ${String(v)}`)
                    .join(" · ")}
                </span>
              ) : null}
              <span className="ml-auto whitespace-nowrap text-xs text-neutral-400">
                {new Date(entry.createdAt).toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
