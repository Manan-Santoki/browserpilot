import { desc, eq } from "drizzle-orm";
import { userPermissions, users } from "@browserpilot/db";
import { requirePermission } from "@/lib/auth";
import { db } from "@/lib/db";
import { AdminHeader, AdminSection, AdminStatus, type StatusItem } from "../shell";
import { UserRow } from "./user-row";
import { AddPerson } from "./add-person";

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<{ reset?: string; for?: string }>;
}) {
  const admin = await requirePermission("user.manage");
  const { reset, for: resetFor } = await searchParams;

  const people = await db()
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      isActive: users.isActive,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(desc(users.createdAt));

  const permRows = await db()
    .select({ userId: userPermissions.userId, permission: userPermissions.permission })
    .from(userPermissions);
  const permsByUser = new Map<string, string[]>();
  for (const row of permRows) {
    permsByUser.set(row.userId, [...(permsByUser.get(row.userId) ?? []), row.permission]);
  }

  const active = people.filter((p) => p.isActive).length;
  const admins = people.filter((p) => p.role === "ADMIN" && p.isActive).length;

  // Counts worth acting on: an account nobody has deactivated is an account
  // that can still sign in, and one administrator is a lockout waiting to
  // happen.
  const status: StatusItem[] = [
    {
      label: "Can sign in",
      value: `${active} of ${people.length}`,
      tone: "idle",
      hint: active === people.length ? undefined : `${people.length - active} deactivated`,
    },
    {
      label: "Administrators",
      value: `${admins}`,
      tone: admins === 1 ? "warn" : "idle",
      hint: admins === 1 ? "only one — losing it locks everyone out" : undefined,
    },
  ];

  return (
    <>
      <AdminHeader
        title="Users"
        description="Who may sign in, and what each of them is allowed to do. Deactivating keeps everything and only blocks the account."
      />

      <AdminStatus items={status} />

      {reset && resetFor ? (
        <div className="border-running/40 bg-running/5 space-y-2 rounded-lg border p-4 text-sm">
          <p className="text-running">
            Reset {resetFor}&apos;s password. Copy it now — it is shown once.
          </p>
          <code className="bg-background block rounded px-2 py-1.5 font-mono text-xs break-all">
            {reset}
          </code>
        </div>
      ) : null}

      <AdminSection title="Accounts">
        {people.length === 0 ? (
          <p className="text-muted-foreground py-4 text-center text-sm">
            No accounts yet. Add the first one below.
          </p>
        ) : (
          <ul className="divide-border -mx-5 -my-5 divide-y">
            {people.map((person) => (
              <UserRow
                key={person.id}
                person={{
                  id: person.id,
                  name: person.name,
                  email: person.email,
                  role: person.role,
                  isActive: person.isActive,
                  createdAt: person.createdAt,
                }}
                isSelf={person.id === admin.id}
                perms={permsByUser.get(person.id) ?? []}
              />
            ))}
          </ul>
        )}
      </AdminSection>

      <AddPerson />
    </>
  );
}
