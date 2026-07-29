"use client";

import Link from "next/link";
import { Card } from "@/components/ui/card";
import { FileRow, FileViewer, useFileViewer } from "@/components/file-viewer";

export type SessionFiles = {
  sessionId: string;
  title: string;
  siteName: string | null;
  startedAt: string;
  files: Array<{ filename: string; url: string; at: string }>;
};

/**
 * Downloads, under the session that produced them.
 *
 * A flat list stops being useful the moment there are two purchase orders with
 * similar names — what tells them apart is which run fetched them, and for
 * what. Grouping restores that context, and the group header is a way back
 * into the conversation that explains the file.
 */
export function FilesList({ groups }: { groups: SessionFiles[] }) {
  const viewer = useFileViewer();

  return (
    <>
      <div className="space-y-4">
        {groups.map((group) => (
          <Card key={group.sessionId} className="gap-0 overflow-hidden py-0">
            <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b px-4 py-2.5">
              <Link
                href={`/sessions/${group.sessionId}`}
                className="truncate text-sm font-medium hover:underline"
              >
                {group.title}
              </Link>
              <span className="text-muted-foreground shrink-0 font-mono text-xs">
                {group.siteName ? `${group.siteName} · ` : ""}
                {new Date(group.startedAt).toLocaleString()}
              </span>
            </header>

            <div className="divide-y">
              {group.files.map((file) => (
                <FileRow
                  key={file.filename}
                  filename={file.filename}
                  url={file.url}
                  meta={new Date(file.at).toLocaleTimeString()}
                  onView={(f) => viewer.open({ ...f, sessionTitle: group.title })}
                />
              ))}
            </div>
          </Card>
        ))}
      </div>

      <FileViewer file={viewer.file} onClose={viewer.close} />
    </>
  );
}
