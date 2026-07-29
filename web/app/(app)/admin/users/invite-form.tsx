"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { inviteUser, type AdminState } from "../actions";

const ROLES = [
  { value: "USER", label: "User" },
  { value: "ADMIN", label: "Admin" },
];

const initial: AdminState = {};

export function InviteForm() {
  const [state, action, pending] = useActionState(inviteUser, initial);

  return (
    <form action={action} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="email">
          Email
        </Label>
        <Input
          id="email"
          name="email"
          type="email"
          required
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="role">
          Role
        </Label>
        <Select name="role" defaultValue="USER" items={ROLES}>
          <SelectTrigger id="role" className="w-[160px]">
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
      </div>

      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}

      {state.success ? (
        <div className="space-y-2 rounded-md border-running/40 bg-running/5 border p-3">
          <p className="text-running text-sm">{state.success}</p>
          {state.inviteUrl ? (
            <code className="bg-background block rounded px-2 py-1.5 font-mono text-xs break-all">
              {state.inviteUrl}
            </code>
          ) : null}
        </div>
      ) : null}

      <Button type="submit" disabled={pending}>
        {pending ? "Creating invite…" : "Create invite"}
      </Button>
    </form>
  );
}
