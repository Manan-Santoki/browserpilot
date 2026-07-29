import "server-only";
import { redirect } from "next/navigation";
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
