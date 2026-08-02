"use client";

import { useActionState, useState } from "react";
import { PERMISSIONS, PERMISSION_LABELS } from "@browserpilot/core";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createUser, inviteUser, type AdminState } from "../actions";
import { AdminSection } from "../shell";
import { ROLES } from "./roles";

/**
 * One way in, with a choice of how it finishes.
 *
 * These were two cards side by side — "Create an account" and "Invite someone"
 * — which asked a person to decide between two things that do the same job
 * before either had explained itself. They differ in exactly one way: whether
 * you hand over a password or a link. So it is one form, and that difference
 * is the only choice on it.
 */
const initial: AdminState = {};

type Method = "create" | "invite";

const METHODS: Array<{ value: Method; label: string; blurb: string }> = [
  {
    value: "create",
    label: "Set a password now",
    blurb: "The account works immediately. A temporary password is shown once, for you to pass on.",
  },
  {
    value: "invite",
    label: "Send an invite link",
    blurb: "They choose their own password. The link works once and expires after 7 days.",
  },
];

export function AddPerson() {
  const [method, setMethod] = useState<Method>("create");
  const [state, action, pending] = useActionState(
    async (prev: AdminState, data: FormData) =>
      data.get("method") === "invite" ? inviteUser(prev, data) : createUser(prev, data),
    initial,
  );

  const chosen = METHODS.find((m) => m.value === method)!;

  return (
    <AdminSection
      title="Add someone"
      description="New accounts start as a User with no permissions, which is enough to sign in and nothing else."
    >
      <form action={action} className="space-y-5">
        <input type="hidden" name="method" value={method} />

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="add-name">Name</Label>
            <Input
              id="add-name"
              name="name"
              required={method === "create"}
              placeholder="Ada Lovelace"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="add-email">Email</Label>
            <Input
              id="add-email"
              name="email"
              type="email"
              required
              placeholder="ada@example.com"
            />
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="add-role">Role</Label>
            <Select name="role" defaultValue="USER" items={ROLES}>
              <SelectTrigger id="add-role" className="w-full">
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

          <div className="space-y-2">
            <Label htmlFor="add-method">How they sign in first</Label>
            <Select
              value={method}
              onValueChange={(v) => setMethod((v as Method) ?? "create")}
              items={METHODS}
            >
              <SelectTrigger id="add-method" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {METHODS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <p className="text-muted-foreground text-xs leading-relaxed">{chosen.blurb}</p>

        {method === "create" ? (
          <fieldset className="border-border space-y-3 rounded-lg border p-4">
            <legend className="px-1.5 text-sm font-medium">Permissions</legend>
            <p className="text-muted-foreground -mt-1 text-xs">
              These refine what a User may do. An administrator already has all of them.
            </p>
            <div className="grid gap-x-6 gap-y-2.5 sm:grid-cols-2">
              {PERMISSIONS.map((permission) => (
                <label
                  key={permission}
                  className="flex cursor-pointer items-center gap-2.5 text-sm"
                >
                  <Checkbox name="permissions" value={permission} />
                  <span>{PERMISSION_LABELS[permission]}</span>
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}

        {state.error ? (
          <p role="alert" className="text-destructive text-sm">
            {state.error}
          </p>
        ) : null}

        {state.success ? (
          <div className="border-running/40 bg-running/5 space-y-2 rounded-lg border p-3">
            <p className="text-running text-sm">{state.success}</p>
            {state.inviteUrl ? (
              <code className="bg-background block rounded px-2 py-1.5 font-mono text-xs break-all">
                {state.inviteUrl}
              </code>
            ) : null}
          </div>
        ) : null}

        <Button type="submit" disabled={pending}>
          {pending
            ? method === "invite"
              ? "Creating link…"
              : "Creating account…"
            : method === "invite"
              ? "Create invite link"
              : "Create account"}
        </Button>
      </form>
    </AdminSection>
  );
}
