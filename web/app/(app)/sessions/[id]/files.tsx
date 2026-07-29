import { asc, eq } from "drizzle-orm";
import { sessionEvents } from "@browserpilot/db";
import { db } from "@/lib/db";
import { Card } from "@/components/ui/card";
import { SessionFileRows } from "./file-rows";

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
    <Card className="gap-0 py-0">
      <header className="text-muted-foreground border-b px-4 py-2.5 font-mono text-xs tracking-wider uppercase">
        Files ({files.length})
      </header>
      <SessionFileRows files={files} />
    </Card>
  );
}
