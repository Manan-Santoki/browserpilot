"use client";

import { useActionState } from "react";
import { saveSettings, type AdminState } from "../actions";

const initial: AdminState = {};

const field =
  "w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-900";

export function SettingsForm({
  current,
}: {
  current: {
    perUserSessionLimit: number;
    globalSessionLimit: number;
    idleTimeoutMs: number;
    hardCapMs: number;
    defaultModel: string;
  };
}) {
  const [state, action, pending] = useActionState(saveSettings, initial);

  const rows: Array<{ key: keyof typeof current; label: string; hint: string }> = [
    {
      key: "perUserSessionLimit",
      label: "Browsers per person",
      hint: "How many one person may run at the same time.",
    },
    {
      key: "globalSessionLimit",
      label: "Browsers in total",
      hint: "Across everyone. Bounded by this server's memory.",
    },
    {
      key: "idleTimeoutMs",
      label: "Idle timeout (ms)",
      hint: "A session with no activity for this long is stopped. 600000 is ten minutes.",
    },
    {
      key: "hardCapMs",
      label: "Maximum lifetime (ms)",
      hint: "A session is stopped after this long however busy it is. 3600000 is one hour.",
    },
  ];

  return (
    <form action={action} className="space-y-5">
      {rows.map((row) => (
        <div key={row.key}>
          <label htmlFor={row.key} className="mb-1.5 block text-sm font-medium">
            {row.label}
          </label>
          <input
            id={row.key}
            name={row.key}
            type="number"
            min={1}
            defaultValue={current[row.key] as number}
            className={field}
          />
          <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{row.hint}</p>
        </div>
      ))}

      <div>
        <label htmlFor="defaultModel" className="mb-1.5 block text-sm font-medium">
          Model
        </label>
        <input
          id="defaultModel"
          name="defaultModel"
          defaultValue={current.defaultModel}
          className={field}
        />
        <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
          Applies to sessions started from now on; running sessions keep the model they began with.
        </p>
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
        {pending ? "Saving…" : "Save limits"}
      </button>
    </form>
  );
}
