"use client";

import { useActionState } from "react";
import { acceptInvite, type AcceptState } from "./actions";

const initial: AcceptState = {};

const field =
  "w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-900";

export function AcceptForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState(acceptInvite, initial);

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="token" value={token} />

      <div>
        <label htmlFor="name" className="mb-1.5 block text-sm font-medium">
          Your name
        </label>
        <input id="name" name="name" required autoFocus className={field} />
      </div>

      <div>
        <label htmlFor="password" className="mb-1.5 block text-sm font-medium">
          Password
        </label>
        <input
          id="password"
          name="password"
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
          Confirm password
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

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
      >
        {pending ? "Creating account…" : "Create account"}
      </button>
    </form>
  );
}
