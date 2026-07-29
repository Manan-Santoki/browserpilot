"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { acceptInvite, type AcceptState } from "./actions";

const initial: AcceptState = {};


export function AcceptForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState(acceptInvite, initial);

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="token" value={token} />

      <div className="space-y-2">
        <Label htmlFor="name">
          Your name
        </Label>
        <Input id="name" name="name" required autoFocus  />
      </div>

      <div className="space-y-2">
        <Label htmlFor="password">
          Password
        </Label>
        <Input
          id="password"
          name="password"
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
          Confirm password
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

      <Button type="submit"
        disabled={pending}
        className="w-full"
      >
        {pending ? "Creating account…" : "Create account"}
      </Button>
    </form>
  );
}
