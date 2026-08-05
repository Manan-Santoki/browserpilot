import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { requireJobModeEnabled } from "@/lib/job-mode";

const views = [
  ["/jobs/applications", "Applications"],
  ["/jobs/profile", "Profile & documents"],
  ["/jobs/answers", "Application answers"],
  ["/jobs/accounts", "Accounts & Gmail"],
] as const;

export default async function JobsLayout({ children }: { children: React.ReactNode }) {
  requireJobModeEnabled();
  await requirePermission("job.apply");
  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Jobs</h1>
        <p className="text-muted-foreground mt-1 text-sm">Private, owner-only application automation with evidence-gated submission.</p>
      </div>
      <nav className="flex gap-1 overflow-x-auto border-b" aria-label="Jobs views">
        {views.map(([href, label]) => (
          <Link key={href} href={href} className="hover:text-foreground text-muted-foreground whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-sm hover:border-current">
            {label}
          </Link>
        ))}
      </nav>
      {children}
    </div>
  );
}
