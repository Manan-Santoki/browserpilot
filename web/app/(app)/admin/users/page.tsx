import { desc } from "drizzle-orm";
import { users } from "@browserpilot/db";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { setUserActive, setUserRole } from "../actions";
import { InviteForm } from "./invite-form";

export default async function UsersPage() {
  const admin = await requireAdmin();

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

  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Users</h1>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          Accounts are created by invitation only.
        </p>
      </div>

      <ul className="divide-y divide-neutral-200 rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
        {people.map((person) => {
          const isSelf = person.id === admin.id;
          return (
            <li key={person.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">
                  {person.name}
                  {isSelf ? <span className="ml-2 text-xs text-neutral-400">you</span> : null}
                </p>
                <p className="truncate text-sm text-neutral-500 dark:text-neutral-400">
                  {person.email}
                </p>
              </div>

              {!person.isActive ? (
                <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-500 dark:bg-neutral-800">
                  deactivated
                </span>
              ) : null}

              <form action={setUserRole} className="flex items-center gap-2">
                <input type="hidden" name="userId" value={person.id} />
                <select
                  name="role"
                  defaultValue={person.role}
                  disabled={isSelf}
                  className="rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900"
                >
                  <option value="USER">User</option>
                  <option value="ADMIN">Admin</option>
                </select>
                <button
                  type="submit"
                  disabled={isSelf}
                  className="text-sm text-neutral-500 underline-offset-4 hover:underline disabled:opacity-40 dark:text-neutral-400"
                >
                  Save
                </button>
              </form>

              <form action={setUserActive}>
                <input type="hidden" name="userId" value={person.id} />
                <input type="hidden" name="active" value={person.isActive ? "false" : "true"} />
                <button
                  type="submit"
                  disabled={isSelf}
                  className="text-sm text-neutral-500 underline-offset-4 hover:underline disabled:opacity-40 dark:text-neutral-400"
                >
                  {person.isActive ? "Deactivate" : "Reactivate"}
                </button>
              </form>
            </li>
          );
        })}
      </ul>

      <section className="max-w-lg">
        <h2 className="text-base font-medium">Invite someone</h2>
        <div className="mt-4">
          <InviteForm />
        </div>
      </section>
    </div>
  );
}
