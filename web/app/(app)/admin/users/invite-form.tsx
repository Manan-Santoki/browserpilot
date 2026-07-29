"use client";

import { useActionState } from "react";
import { inviteUser, type AdminState } from "../actions";

const initial: AdminState = {};

export function InviteForm() {
  const [state, action, pending] = useActionState(inviteUser, initial);

  return (
    <form action={action} className="space-y-4">
      <div>
        <label htmlFor="email" className="mb-1.5 block text-sm font-medium">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-900"
        />
      </div>

      <div>
        <label htmlFor="role" className="mb-1.5 block text-sm font-medium">
          Role
        </label>
        <select
          id="role"
          name="role"
          defaultValue="USER"
          className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        >
          <option value="USER">User</option>
          <option value="ADMIN">Admin</option>
        </select>
      </div>

      {state.error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {state.error}
        </p>
      ) : null}

      {state.success ? (
        <div className="space-y-2 rounded-md border border-green-300 bg-green-50 p-3 dark:border-green-800 dark:bg-green-950/40">
          <p className="text-sm text-green-800 dark:text-green-300">{state.success}</p>
          {state.inviteUrl ? (
            <code className="block break-all rounded bg-white px-2 py-1.5 text-xs dark:bg-neutral-900">
              {state.inviteUrl}
            </code>
          ) : null}
        </div>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
      >
        {pending ? "Creating invite…" : "Create invite"}
      </button>
    </form>
  );
}
