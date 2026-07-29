import type { ChatItem } from "@/lib/transcript";

/**
 * The conversation of a finished session, read-only.
 *
 * A session that has ended still has a story worth reading — what was asked,
 * what the robot did, what it downloaded. Replacing that with only a "this has
 * ended" notice threw away the part people come back for.
 */
export function TranscriptView({ items }: { items: ChatItem[] }) {
  if (items.length === 0) {
    return (
      <p className="text-sm text-neutral-500 dark:text-neutral-400">
        Nothing was said in this session.
      </p>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border border-neutral-200 px-4 py-4 text-sm dark:border-neutral-800">
      {items.map((item, i) => {
        if (item.kind === "you") {
          return (
            <p key={i} className="text-right">
              <span className="inline-block rounded-lg bg-neutral-900 px-3 py-1.5 text-white dark:bg-white dark:text-neutral-900">
                {item.text}
              </span>
            </p>
          );
        }
        if (item.kind === "agent") {
          return (
            <p key={i} className="whitespace-pre-wrap">
              {item.text}
            </p>
          );
        }
        if (item.kind === "tool") {
          return (
            <p key={i} className="text-xs text-neutral-400">
              {item.text}
            </p>
          );
        }
        if (item.kind === "error") {
          return (
            <p key={i} className="text-red-600 dark:text-red-400">
              {item.text}
            </p>
          );
        }
        if (item.kind === "file") {
          return (
            <p key={i}>
              <a href={item.url} className="underline underline-offset-4">
                ⬇ {item.filename}
              </a>
            </p>
          );
        }
        return (
          <p key={i} className="text-xs text-amber-700 dark:text-amber-500">
            {item.summary} — {item.resolved ?? "never answered"}
          </p>
        );
      })}
    </div>
  );
}
