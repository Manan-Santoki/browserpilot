/**
 * Granular permissions that refine the coarse `USER` role.
 *
 * `ADMIN` implies every permission; a `USER` holds exactly the rows granted
 * here. The list is shared by the console (which grants them) and the runtime
 * (which enforces them via the session ticket), so it lives in core.
 */
export const PERMISSIONS = [
  "session.start",
  "session.approve",
  "session.view_others",
  "session.stop_others",
  "user.manage",
  "site.manage",
  "model.manage",
  "storage.manage",
  "audit.view",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const PERMISSION_LABELS: Record<Permission, string> = {
  "session.start": "Start sessions",
  "session.approve": "Approve actions on shared sessions",
  "session.view_others": "Watch anyone's sessions",
  "session.stop_others": "Stop anyone's sessions",
  "user.manage": "Manage users",
  "site.manage": "Manage sites",
  "model.manage": "Manage models & provider",
  "storage.manage": "Manage storage",
  "audit.view": "View the audit log",
};

export function isPermission(value: unknown): value is Permission {
  return typeof value === "string" && (PERMISSIONS as readonly string[]).includes(value);
}

/** A role implies every permission — the coarse switch stays the coarse switch. */
export function canAccess(role: "ADMIN" | "USER", perms: string[], permission: Permission): boolean {
  return role === "ADMIN" || perms.includes(permission);
}

/**
 * The permissions a submitted form is asking for.
 *
 * Two shapes have to work, because two surfaces post this differently: a set
 * of checkboxes all named `permissions`, and the editor dialog, which joins
 * its selection into one comma-separated field.
 *
 * It lives here rather than beside the form because of the bug it replaces:
 * reading the field with `formData.get` returned only the *first* value of a
 * repeated field, so an administrator ticked five boxes and the account was
 * granted one — with nothing on screen to say the rest had been dropped.
 */
export function parsePermissions(values: readonly string[]): Permission[] {
  const flattened = values.flatMap((value) => value.split(",")).map((value) => value.trim());

  // Deduplicated: the two shapes can overlap, and a repeated row violates the
  // table's own uniqueness constraint rather than being quietly ignored.
  return [...new Set(flattened)].filter(isPermission);
}
