"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { changePassword, type AccountState } from "./actions";

const initial: AccountState = {};


export function PasswordForm() {
  const [state, action, pending] = useActionState(changePassword, initial);

  return (
    <form action={action} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="current">
          Current password
        </Label>
        <Input
          id="current"
          name="current"
          type="password"
          required
          autoComplete="current-password"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="next">
          New password
        </Label>
        <Input
          id="next"
          name="next"
          type="password"
          required
          minLength={12}
          autoComplete="new-password"
        />
        <p className="mt-1 text-xs text-muted-foreground">
          At least 12 characters.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="confirm">
          Confirm new password
        </Label>
        <Input
          id="confirm"
          name="confirm"
          type="password"
          required
          autoComplete="new-password"
        />
      </div>

      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}
      {state.success ? (
        <p className="text-sm text-running">{state.success}</p>
      ) : null}

      <Button type="submit" disabled={pending}>
        {pending ? "Changing…" : "Change password"}
      </Button>
    </form>
  );
}
