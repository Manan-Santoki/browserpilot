import { and, eq } from "drizzle-orm";
import { siteAccounts, siteProfiles } from "@browserpilot/db";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { AddSiteForm, LinkAccountForm } from "./forms";

export default async function SitesPage() {
  const user = await requireUser();

  const sites = await db()
    .select({
      id: siteProfiles.id,
      name: siteProfiles.name,
      baseUrl: siteProfiles.baseUrl,
      cookieName: siteProfiles.cookieName,
      isActive: siteProfiles.isActive,
      accountEmail: siteAccounts.targetEmail,
    })
    .from(siteProfiles)
    .leftJoin(
      siteAccounts,
      and(eq(siteAccounts.siteProfileId, siteProfiles.id), eq(siteAccounts.userId, user.id)),
    )
    .orderBy(siteProfiles.name);

  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Sites</h1>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          Applications the robot can drive. Each needs your account on it before you can start a
          session.
        </p>
      </div>

      {sites.length === 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-300 px-6 py-12 text-center dark:border-neutral-700">
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            No sites registered yet.
            {user.role === "ADMIN"
              ? " Add one below."
              : " Ask an administrator to register one."}
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-neutral-200 rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
          {sites.map((site) => (
            <li key={site.id} className="px-4 py-4">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="font-medium">{site.name}</span>
                <span className="text-sm text-neutral-500 dark:text-neutral-400">
                  {site.baseUrl}
                </span>
                {!site.isActive ? (
                  <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-500 dark:bg-neutral-800">
                    disabled
                  </span>
                ) : null}
              </div>

              {site.accountEmail ? (
                <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
                  You act as <span className="font-medium">{site.accountEmail}</span> here.
                </p>
              ) : (
                <details className="mt-3">
                  <summary className="cursor-pointer text-sm text-amber-700 dark:text-amber-500">
                    You have no account on this site yet — add one to start sessions
                  </summary>
                  <div className="mt-3 max-w-lg">
                    <LinkAccountForm siteProfileId={site.id} siteName={site.name} />
                  </div>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}

      {user.role === "ADMIN" ? (
        <section className="max-w-lg">
          <h2 className="text-base font-medium">Register a site</h2>
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            The signing secret must match the target application&apos;s own session secret — that is
            what lets the robot arrive already logged in. It is encrypted before it is stored.
          </p>
          <div className="mt-4">
            <AddSiteForm />
          </div>
        </section>
      ) : null}
    </div>
  );
}
