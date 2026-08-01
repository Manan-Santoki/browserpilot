import Link from "next/link";
import { count, eq, inArray } from "drizzle-orm";
import { auditLogs, robotSessions, settings, siteProfiles, users } from "@browserpilot/db";
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

  // What the console can say about storage without unsealing anything.
  const [driverRow] = await db()
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, "storageDriver"))
    .limit(1);
  const [bucketRow] = await db()
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, "s3Bucket"))
    .limit(1);

  const storageLabel =
    driverRow?.value === "local"
      ? "this server's disk"
      : typeof bucketRow?.value === "string" && bucketRow.value
        ? String(bucketRow.value)
        : "the bundled bucket";

  const [baseUrlRow] = await db()
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, "providerBaseUrl"))
    .limit(1);

  const providerLabel =
    typeof baseUrlRow?.value === "string" && baseUrlRow.value
      ? new URL(baseUrlRow.value).host
      : "Anthropic";

  const cards = [
    { href: "/admin/users", title: "Users", value: `${activeUsers?.n ?? 0} active of ${userCount?.n ?? 0}`, blurb: "Invite people, change roles, deactivate accounts." },
    { href: "/sites", title: "Sites", value: `${siteCount?.n ?? 0} registered`, blurb: "Applications the robot can drive." },
    { href: "/admin/settings", title: "Limits", value: `${liveSessions?.n ?? 0} browsers running`, blurb: "Concurrency caps, timeouts, and the default model." },
    { href: "/admin/models", title: "Models", value: providerLabel, blurb: "Which provider the agent talks to, and what it may run." },
    { href: "/admin/storage", title: "Storage", value: storageLabel, blurb: "Where downloaded files are kept." },
    { href: "/admin/audit", title: "Audit log", value: `${auditCount?.n ?? 0} entries`, blurb: "Who did what, and when." },
  ];

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Admin</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Everything here affects other people, so each change is written to the audit log.
        </p>
      </div>

      <ul className="grid gap-4 sm:grid-cols-2">
        {cards.map((card) => (
          <li key={card.href}>
            <Link
              href={card.href}
              className="hover:border-signal/50 block rounded-lg border p-4 transition-colors"
            >
              <p className="text-sm text-muted-foreground">{card.title}</p>
              <p className="mt-1 text-lg font-medium">{card.value}</p>
              <p className="mt-1 text-sm text-muted-foreground">{card.blurb}</p>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
