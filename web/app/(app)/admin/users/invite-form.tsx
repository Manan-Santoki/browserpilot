"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { inviteUser, type AdminState } from "../actions";

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
        <select
          id="role"
          name="role"
          defaultValue="USER"
          className="border-input bg-background focus-visible:ring-ring/50 rounded-md border px-3 py-2 text-sm outline-none focus-visible:ring-3"
        >
          <option value="USER">User</option>
          <option value="ADMIN">Admin</option>
        </select>
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
