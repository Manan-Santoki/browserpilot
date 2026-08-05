import { redirect } from "next/navigation";
import { hasAdminAccess, requireUser } from "@/lib/auth";
import { AdminTabs } from "./tabs";

/**
 * Tabs are filtered by what this person may actually reach.
 *
 * A tab that 403s when you click it is worse than no tab: it advertises a
 * capability and then denies it. The pages enforce the same permission again —
 * this list decides what is *offered*, `requirePermission` decides what is
 * *allowed*, and only the second one is security.
 */
const TABS = [
  { href: "/admin", label: "Overview" },
  { href: "/admin/users", label: "Users", perm: "user.manage" },
  { href: "/admin/settings", label: "Limits", adminOnly: true },
  { href: "/admin/models", label: "Models", perm: "model.manage" },
  { href: "/admin/storage", label: "Storage", perm: "storage.manage" },
  { href: "/admin/audit", label: "Audit", perm: "audit.view" },
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  if (!hasAdminAccess(user)) redirect("/");

  const visible = TABS.filter((tab) => {
    if (tab.adminOnly) return user.role === "ADMIN";
    if (!tab.perm) return true;
    return user.role === "ADMIN" || user.perms.includes(tab.perm);
  });

  // The one width in the section. Pages set none of their own — see shell.tsx.
  return (
    <div className="mx-auto w-full max-w-4xl">
      <AdminTabs tabs={visible.map(({ href, label }) => ({ href, label }))} />
      <div className="space-y-7 pt-7">{children}</div>
    </div>
  );
}
