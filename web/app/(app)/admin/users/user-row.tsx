"use client";

import { MoreHorizontalIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConfirmAction } from "@/components/confirm-action";
import { deleteUser, resetUserPassword, setUserActive, setUserRole } from "../actions";
import { PermissionsEditor } from "./permissions-editor";
import { ROLES } from "./roles";

type Person = {
  id: string;
  name: string;
  email: string;
  role: "ADMIN" | "USER";
  isActive: boolean;
  createdAt: Date;
};

/**
 * One account.
 *
 * Identity on the left, what they may do on the right, everything rarer behind
 * the menu. The role select saves on change rather than beside its own Save
 * button — a two-control pair for one decision was the densest thing on the
 * page, and forgetting the second half silently discarded the first.
 */
export function UserRow({
  person,
  isSelf,
  perms,
}: {
  person: Person;
  isSelf: boolean;
  perms: string[];
}) {
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3.5">
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 truncate text-sm font-medium">
          {person.name}
          {isSelf ? <span className="text-muted-foreground text-xs">you</span> : null}
          {!person.isActive ? (
            <Badge variant="secondary" className="font-normal">
              deactivated
            </Badge>
          ) : null}
        </p>
        <p className="text-muted-foreground truncate font-mono text-xs">{person.email}</p>
      </div>

      <div className="flex items-center gap-1.5">
        <form action={setUserRole} id={`role-${person.id}`}>
          <input type="hidden" name="userId" value={person.id} />
          <Select
            name="role"
            defaultValue={person.role}
            disabled={isSelf}
            items={ROLES}
            // Saved on change: the role and its Save button were two controls
            // for one decision, and only the second one counted.
            onValueChange={(value) => {
              if (value) (document.getElementById(`role-${person.id}`) as HTMLFormElement)?.requestSubmit();
            }}
          >
            <SelectTrigger size="sm" className="w-[92px]" aria-label={`Role for ${person.name}`}>
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
        </form>

        <PermissionsEditor
          userId={person.id}
          perms={perms}
          role={person.role}
          name={person.name}
        />

        <DropdownMenu>
          {/* The trigger renders its own button. Passing a <Button> through
              `render` made the server and client disagree about `data-slot`,
              which React reported as a hydration mismatch on every load. */}
          <DropdownMenuTrigger
            aria-label={`More actions for ${person.name}`}
            className="text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring inline-flex size-8 items-center justify-center rounded-md transition-colors focus-visible:ring-2 focus-visible:outline-none"
          >
            <MoreHorizontalIcon className="size-4" />
          </DropdownMenuTrigger>

          <DropdownMenuContent align="end">
            <DropdownMenuLabel>Account</DropdownMenuLabel>
            {isSelf ? (
              <DropdownMenuItem disabled>Deactivate (that&apos;s you)</DropdownMenuItem>
            ) : person.isActive ? (
              <ConfirmAction
                action={setUserActive}
                fields={{ userId: person.id, active: "false" }}
                label="Deactivate"
                title={`Deactivate ${person.name}?`}
                description="They are signed out and cannot sign in again or start sessions. Their past sessions and files are kept, and you can reactivate them at any time."
                confirmLabel="Deactivate"
                destructive
                dropdown
              />
            ) : (
              <form action={setUserActive}>
                <input type="hidden" name="userId" value={person.id} />
                <input type="hidden" name="active" value="true" />
                <button
                  type="submit"
                  className="focus:bg-accent focus:text-accent-foreground w-full rounded-sm px-1.5 py-1 text-left text-sm outline-hidden select-none"
                >
                  Reactivate
                </button>
              </form>
            )}
            {isSelf ? null : (
              <>
                <form action={resetUserPassword}>
                  <input type="hidden" name="userId" value={person.id} />
                  <button
                    type="submit"
                    className="focus:bg-accent focus:text-accent-foreground w-full rounded-sm px-1.5 py-1 text-left text-sm outline-hidden select-none"
                  >
                    Reset password
                  </button>
                </form>
                <DropdownMenuSeparator />
                <ConfirmAction
                  action={deleteUser}
                  fields={{ userId: person.id }}
                  label="Delete account"
                  title={`Delete ${person.name}?`}
                  description="Their account, sessions, shared-session grants and sign-ins are removed. Anything they downloaded is kept. This cannot be undone."
                  confirmLabel="Delete account"
                  destructive
                  dropdown
                />
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
}
