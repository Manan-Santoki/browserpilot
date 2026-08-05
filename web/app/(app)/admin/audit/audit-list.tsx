"use client";

import { useMemo, useState } from "react";
import { PHRASING } from "./phrasing";
import { cn } from "@/lib/utils";

type Entry = {
  id: string;
  action: string;
  createdAt: Date;
  metadata: unknown;
  actorName: string | null;
  actorEmail: string | null;
};

export function AuditList({ entries }: { entries: Entry[] }) {
  const [action, setAction] = useState<string | null>(null);
  const [person, setPerson] = useState<string | null>(null);

  /**
   * Only the kinds of event this log actually contains.
   *
   * These chips were the first eight of the full vocabulary, sorted
   * alphabetically — so most of them matched nothing, and the events that were
   * really there had no chip at all. A filter that cannot change what you see
   * is not a filter.
   */
  const kinds = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of entries) {
      counts.set(entry.action, (counts.get(entry.action) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([value, n]) => ({ value, n }));
  }, [entries]);

  const people = useMemo(() => {
    const seen = new Map<string, string>();
    for (const entry of entries) {
      if (entry.actorName) seen.set(entry.actorName, entry.actorName);
    }
    return [...seen.keys()].sort();
  }, [entries]);

  const filtered = entries.filter(
    (entry) =>
      (!action || entry.action === action) &&
      (!person || entry.actorName === person),
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap gap-1.5">
          <FilterChip active={action === null} onClick={() => setAction(null)}>
            All
          </FilterChip>
          {kinds.map((kind) => (
            <FilterChip
              key={kind.value}
              active={action === kind.value}
              onClick={() => setAction(action === kind.value ? null : kind.value)}
            >
              {PHRASING[kind.value] ?? kind.value}
              <span className="text-muted-foreground ml-1.5 tabular">{kind.n}</span>
            </FilterChip>
          ))}
        </div>

        {people.length > 1 ? (
          <select
            value={person ?? ""}
            onChange={(e) => setPerson(e.target.value || null)}
            className="border-input bg-background hover:bg-accent/50 h-7 rounded-md border px-2 text-xs outline-none"
            aria-label="Filter by person"
          >
            <option value="">Everyone</option>
            {people.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        ) : null}

        <p className="text-muted-foreground text-sm">
          {filtered.length} of {entries.length}
        </p>
      </div>

      {filtered.length === 0 ? (
        <p className="text-muted-foreground text-sm">Nothing matches that filter.</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border text-sm">
          {filtered.map((entry) => (
            <li key={entry.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 px-4 py-2.5">
              <span className="font-medium">{entry.actorName ?? "Someone"}</span>
              <span className="text-foreground/90">
                {PHRASING[entry.action] ?? entry.action}
              </span>
              {entry.metadata ? (
                <span className="text-muted-foreground truncate text-xs">
                  {Object.entries(entry.metadata as Record<string, unknown>)
                    .map(([k, v]) => `${k}: ${String(v)}`)
                    .join(" · ")}
                </span>
              ) : null}
              <span className="text-muted-foreground ml-auto whitespace-nowrap text-xs">
                {new Date(entry.createdAt).toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "h-7 rounded-md border px-2.5 text-xs font-medium transition-colors",
        active
          ? "bg-accent text-foreground border-transparent"
          : "border-input text-muted-foreground hover:bg-accent/50 hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
