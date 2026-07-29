"use client";

import { useActionState } from "react";
import { changePassword, type AccountState } from "./actions";

const initial: AccountState = {};

const field =
  "w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-900";

export function PasswordForm() {
  const [state, action, pending] = useActionState(changePassword, initial);

  return (
    <form action={action} className="space-y-4">
      <div>
        <label htmlFor="current" className="mb-1.5 block text-sm font-medium">
          Current password
        </label>
        <input
          id="current"
          name="current"
          type="password"
          required
          autoComplete="current-password"
          className={field}
        />
      </div>

      <div>
        <label htmlFor="next" className="mb-1.5 block text-sm font-medium">
          New password
        </label>
        <input
          id="next"
          name="next"
          type="password"
          required
          minLength={12}
          autoComplete="new-password"
          className={field}
        />
        <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
          At least 12 characters.
        </p>
      </div>

      <div>
        <label htmlFor="confirm" className="mb-1.5 block text-sm font-medium">
          Confirm new password
        </label>
        <input
          id="confirm"
          name="confirm"
          type="password"
          required
          autoComplete="new-password"
          className={field}
        />
      </div>

      {state.error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {state.error}
        </p>
      ) : null}
      {state.success ? (
        <p className="text-sm text-green-700 dark:text-green-400">{state.success}</p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
      >
        {pending ? "Changing…" : "Change password"}
      </button>
    </form>
  );
}
