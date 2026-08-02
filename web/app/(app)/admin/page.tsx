import Link from "next/link";
import { redirect } from "next/navigation";
import { count, desc, eq, inArray } from "drizzle-orm";
import { auditLogs, robotSessions, settings, siteProfiles, users } from "@browserpilot/db";
import { hasAdminAccess, requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { AdminEyebrow, AdminHeader, AdminStatus, type StatusItem } from "./shell";
import { PHRASING } from "./audit/phrasing";

const LIVE = ["starting", "idle", "working", "awaiting_approval"] as const;

export default async function AdminPage() {
  const user = await requireUser();
  if (!hasAdminAccess(user)) redirect("/");

  const [[userCount], [activeUsers], [siteCount], [liveSessions]] = await Promise.all([
    db().select({ n: count() }).from(users),
    db().select({ n: count() }).from(users).where(eq(users.isActive, true)),
    db().select({ n: count() }).from(siteProfiles),
    db().select({ n: count() }).from(robotSessions).where(inArray(robotSessions.status, [...LIVE])),
  ]);

  const rows = await db()
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(inArray(settings.key, ["storageDriver", "s3Bucket", "providerBaseUrl", "defaultModel"]));
  const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));

  const text = (value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim() : undefined;

  const storageLabel =
    stored.storageDriver === "local"
      ? "This server's disk"
      : (text(stored.s3Bucket) ?? "The bundled bucket");

  const providerHost = text(stored.providerBaseUrl);
  const providerLabel = providerHost ? new URL(providerHost).host : "Anthropic";

  const live = liveSessions?.n ?? 0;

  // Counts a person can act on, not a scoreboard. "Browsers running" is the
  // only one that changes minute to minute, so it leads and is the only one
  // whose lamp ever lights.
  const status: StatusItem[] = [
    {
      label: "Browsers running",
      value: live === 0 ? "None" : `${live}`,
      tone: live > 0 ? "ok" : "idle",
      hint: live > 0 ? "using memory right now" : undefined,
    },
    {
      label: "Accounts",
      value: `${activeUsers?.n ?? 0} active`,
      tone: "idle",
      hint: `of ${userCount?.n ?? 0}`,
    },
  ];

  // `mono` marks a value the machine chose rather than a phrase we wrote. Only
  // those are set in mono, so the typeface itself says which is which.
  const config = [
    { href: "/admin/models", label: "Model provider", value: providerLabel, mono: true },
    {
      href: "/admin/models",
      label: "Default model",
      value: text(stored.defaultModel) ?? "Not set",
      mono: Boolean(text(stored.defaultModel)),
    },
    { href: "/admin/storage", label: "Downloads kept in", value: storageLabel, mono: false },
    {
      href: "/sites",
      label: "Sites the robot can drive",
      value: siteCount?.n === 1 ? "1 site" : `${siteCount?.n ?? 0} sites`,
      mono: false,
    },
  ];

  const recent = await db()
    .select({
      id: auditLogs.id,
      action: auditLogs.action,
      createdAt: auditLogs.createdAt,
      actorName: users.name,
    })
    .from(auditLogs)
    .leftJoin(users, eq(users.id, auditLogs.actorUserId))
    .orderBy(desc(auditLogs.createdAt))
    .limit(6);

  return (
    <>
      <AdminHeader
        title="Admin"
        description="Everything here affects other people, so each change is written to the audit log."
      />

      <AdminStatus items={status} />

      <section className="space-y-3">
        <AdminEyebrow>Configuration</AdminEyebrow>
        <ul className="border-border divide-border divide-y overflow-hidden rounded-xl border">
          {config.map((item) => (
            <li key={item.label}>
              <Link
                href={item.href}
                className="hover:bg-accent/40 flex items-baseline justify-between gap-4 px-4 py-3 text-sm transition-colors"
              >
                <span className="text-muted-foreground">{item.label}</span>
                <span className={`min-w-0 truncate ${item.mono ? "font-mono text-xs" : "text-sm"}`}>
                  {item.value}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-3">
        <div className="flex items-baseline justify-between gap-4">
          <AdminEyebrow>Recent activity</AdminEyebrow>
          <Link href="/admin/audit" className="text-signal text-xs font-medium hover:underline">
            View all
          </Link>
        </div>
        {recent.length === 0 ? (
          <p className="text-muted-foreground border-border rounded-xl border px-4 py-8 text-center text-sm">
            Nothing has been changed yet.
          </p>
        ) : (
          <ul className="border-border divide-border divide-y overflow-hidden rounded-xl border text-sm">
            {recent.map((entry) => (
              <li key={entry.id} className="flex items-baseline gap-3 px-4 py-2.5">
                <span className="min-w-0 truncate">
                  <span className="font-medium">{entry.actorName ?? "Someone"}</span>{" "}
                  <span className="text-muted-foreground">
                    {PHRASING[entry.action] ?? entry.action}
                  </span>
                </span>
                <time
                  dateTime={new Date(entry.createdAt).toISOString()}
                  className="text-muted-foreground ml-auto shrink-0 font-mono text-xs whitespace-nowrap"
                >
                  {new Date(entry.createdAt).toISOString().slice(0, 16).replace("T", " ")}
                </time>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
