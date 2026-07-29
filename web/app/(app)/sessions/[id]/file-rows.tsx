"use client";

import { FileRow, FileViewer, useFileViewer } from "@/components/file-viewer";

/** The session's own downloads, opening in the same viewer as the Files page. */
export function SessionFileRows({ files }: { files: Array<{ filename: string; url: string }> }) {
  const viewer = useFileViewer();

  return (
    <>
      <div className="divide-y">
        {files.map((file) => (
          <FileRow
            key={file.filename}
            filename={file.filename}
            url={file.url}
            onView={viewer.open}
          />
        ))}
      </div>
      <FileViewer file={viewer.file} onClose={viewer.close} />
    </>
  );
}
