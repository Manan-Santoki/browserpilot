import { desc } from "drizzle-orm";
import { ConfirmAction } from "@/components/confirm-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const ROLES = [
  { value: "USER", label: "User" },
  { value: "ADMIN", label: "Admin" },
];
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
        <p className="mt-1 text-sm text-muted-foreground">
          Accounts are created by invitation only.
        </p>
      </div>

      <ul className="divide-y divide-border rounded-lg border">
        {people.map((person) => {
          const isSelf = person.id === admin.id;
          return (
            <li key={person.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">
                  {person.name}
                  {isSelf ? <span className="ml-2 text-xs text-muted-foreground">you</span> : null}
                </p>
                <p className="truncate text-sm text-muted-foreground">
                  {person.email}
                </p>
              </div>

              {!person.isActive ? <Badge variant="secondary">deactivated</Badge> : null}

              <form action={setUserRole} className="flex items-center gap-2">
                <input type="hidden" name="userId" value={person.id} />
                <Select
                  name="role"
                  defaultValue={person.role}
                  disabled={isSelf}
                  items={ROLES}
                >
                  <SelectTrigger size="sm" className="w-[104px]" aria-label="Role">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ROLES.map((role) => (
                      <SelectItem key={role.value} value={role.value}>
                        {role.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button type="submit" size="sm" variant="ghost" disabled={isSelf}>
                  Save
                </Button>
              </form>

              {isSelf ? (
                <Button size="sm" variant="ghost" disabled>
                  Deactivate
                </Button>
              ) : person.isActive ? (
                <ConfirmAction
                  action={setUserActive}
                  fields={{ userId: person.id, active: "false" }}
                  label="Deactivate"
                  title={`Deactivate ${person.name}?`}
                  description="They are signed out and cannot sign in again or start sessions. Their past sessions and files are kept, and you can reactivate them at any time."
                  confirmLabel="Deactivate"
                  destructive
                />
              ) : (
                <form action={setUserActive}>
                  <input type="hidden" name="userId" value={person.id} />
                  <input type="hidden" name="active" value="true" />
                  <Button type="submit" size="sm" variant="ghost">
                    Reactivate
                  </Button>
                </form>
              )}
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
