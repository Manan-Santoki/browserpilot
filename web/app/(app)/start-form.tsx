"use client";

import Link from "next/link";
import { useActionState } from "react";
import { startSession, type StartState } from "./sessions/actions";

const initial: StartState = {};

export function StartSessionForm({ sites }: { sites: Array<{ id: string; name: string }> }) {
  const [state, action, pending] = useActionState(startSession, initial);

  if (sites.length === 0) {
    return (
      <Link
        href="/sites"
        className="rounded-md border border-neutral-300 px-3 py-2 text-sm font-medium hover:bg-neutral-50 dark:border-neutral-600 dark:hover:bg-neutral-900"
      >
        Set up a site first
      </Link>
    );
  }

  return (
    <form action={action} className="flex flex-wrap items-start gap-2">
      <select
        name="siteProfileId"
        required
        aria-label="Site"
        className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
      >
        {sites.map((site) => (
          <option key={site.id} value={site.id}>
            {site.name}
          </option>
        ))}
      </select>

      <select
        name="model"
        aria-label="Model"
        defaultValue=""
        title="Which model drives this session"
        className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
      >
        <option value="">Default model</option>
        <option value="claude-opus-5">Opus 5 — most capable</option>
        <option value="claude-sonnet-5">Sonnet 5 — faster, cheaper</option>
        <option value="claude-haiku-4-5">Haiku 4.5 — fastest</option>
      </select>

      <input
        name="title"
        placeholder="What is this for? (optional)"
        className="w-56 rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
      />

      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
      >
        {pending ? "Starting…" : "New session"}
      </button>

      {state.error ? (
        <p role="alert" className="w-full text-sm text-red-600 dark:text-red-400">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
