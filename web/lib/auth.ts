import "server-only";
import { redirect } from "next/navigation";
import { canAccess, type Permission } from "@browserpilot/core";
import { getCurrentUser, type CurrentUser } from "./session";

/** Use in any page or action that requires a signed-in user. */
export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

/**
 * Use in admin-only pages and actions.
 *
 * Sends non-admins to the dashboard rather than the login page: they are
 * authenticated, just not authorised, and bouncing them to a login form they
 * have already passed is confusing.
 */
export async function requireAdmin(): Promise<CurrentUser> {
  const user = await requireUser();
  if (user.role !== "ADMIN") redirect("/");
  return user;
}

/** Whether a user holds a granular permission. An admin holds them all. */
export function can(user: Pick<CurrentUser, "role" | "perms">, permission: Permission): boolean {
  return canAccess(user.role, user.perms, permission);
}

/** Whether a user may open the admin area at all. */
export function hasAdminAccess(user: Pick<CurrentUser, "role" | "perms">): boolean {
  if (user.role === "ADMIN") return true;
  const ADMIN_PERMISSIONS: Permission[] = [
    "user.manage",
    "site.manage",
    "model.manage",
    "storage.manage",
    "audit.view",
  ];
  return ADMIN_PERMISSIONS.some((permission) => can(user, permission));
}

/**
 * Require a specific permission, redirecting users who lack it to the
 * dashboard. Used where a page or action is fine for any holder of the
 * permission — not just the ADMINS a coarse role check would admit.
 */
export async function requirePermission(permission: Permission): Promise<CurrentUser> {
  const user = await requireUser();
  if (!can(user, permission)) redirect("/");
  return user;
}
