import { asc, eq } from "drizzle-orm";
import { sessionEvents } from "@browserpilot/db";
import { db } from "@/lib/db";

type FileEvent = { filename: string; url: string };

/**
 * Files the robot downloaded during this session.
 *
 * Read from the durable transcript rather than tracked in the client, so they
 * survive a reload and are still listed after the session ends.
 */
export async function SessionFiles({ sessionId }: { sessionId: string }) {
  const rows = await db()
    .select({ payload: sessionEvents.payload })
    .from(sessionEvents)
    .where(eq(sessionEvents.robotSessionId, sessionId))
    .orderBy(asc(sessionEvents.seq));

  const seen = new Map<string, FileEvent>();
  for (const row of rows) {
    const event = row.payload as { type?: string; filename?: string; url?: string };
    if (event.type === "file_ready" && event.filename && event.url) {
      // A file downloaded twice should appear once, most recent wins.
      seen.set(event.filename, { filename: event.filename, url: event.url });
    }
  }

  const files = [...seen.values()];
  if (files.length === 0) return null;

  return (
    <section className="rounded-lg border border-neutral-200 dark:border-neutral-800">
      <header className="border-b border-neutral-200 px-4 py-2.5 text-sm text-neutral-600 dark:border-neutral-800 dark:text-neutral-300">
        Files ({files.length})
      </header>
      <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
        {files.map((file) => (
          <li key={file.filename}>
            <a
              href={file.url}
              className="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-900"
            >
              <span aria-hidden>⬇</span>
              <span className="truncate">{file.filename}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
