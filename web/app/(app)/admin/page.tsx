import Link from "next/link";
import { count, eq, inArray } from "drizzle-orm";
import { auditLogs, robotSessions, siteProfiles, users } from "@browserpilot/db";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";

const LIVE = ["starting", "idle", "working", "awaiting_approval"] as const;

export default async function AdminPage() {
  await requireAdmin();

  const [[userCount], [activeUsers], [siteCount], [liveSessions], [auditCount]] = await Promise.all([
    db().select({ n: count() }).from(users),
    db().select({ n: count() }).from(users).where(eq(users.isActive, true)),
    db().select({ n: count() }).from(siteProfiles),
    db().select({ n: count() }).from(robotSessions).where(inArray(robotSessions.status, [...LIVE])),
    db().select({ n: count() }).from(auditLogs),
  ]);

  const cards = [
    { href: "/admin/users", title: "Users", value: `${activeUsers?.n ?? 0} active of ${userCount?.n ?? 0}`, blurb: "Invite people, change roles, deactivate accounts." },
    { href: "/sites", title: "Sites", value: `${siteCount?.n ?? 0} registered`, blurb: "Applications the robot can drive." },
    { href: "/admin/settings", title: "Limits", value: `${liveSessions?.n ?? 0} browsers running`, blurb: "Concurrency caps, timeouts, and the default model." },
    { href: "/admin/audit", title: "Audit log", value: `${auditCount?.n ?? 0} entries`, blurb: "Who did what, and when." },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Admin</h1>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          Everything here affects other people, so each change is written to the audit log.
        </p>
      </div>

      <ul className="grid gap-4 sm:grid-cols-2">
        {cards.map((card) => (
          <li key={card.href}>
            <Link
              href={card.href}
              className="block rounded-lg border border-neutral-200 p-4 transition-colors hover:border-neutral-400 dark:border-neutral-800 dark:hover:border-neutral-600"
            >
              <p className="text-sm text-neutral-500 dark:text-neutral-400">{card.title}</p>
              <p className="mt-1 text-lg font-medium">{card.value}</p>
              <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">{card.blurb}</p>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
