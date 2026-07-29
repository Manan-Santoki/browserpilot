"use client";

import { useState } from "react";
import { DownloadIcon, ExternalLinkIcon, FileIcon } from "lucide-react";
import { isViewable } from "@browserpilot/core";
import { buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type ViewableFile = {
  filename: string;
  url: string;
  sessionTitle?: string | null;
};

/**
 * Looks at a downloaded file without leaving the console.
 *
 * The robot fetches purchase orders and reports on your behalf, and the point
 * of most of them is to be read once. Making that a round trip through the
 * downloads folder and a separate application is a poor trade for a glance, so
 * anything the browser can render is rendered here, and saving it stays one
 * click away for when you actually want the file.
 *
 * PDFs go in an iframe rather than an <embed>: it is the one element every
 * current browser gives a full viewer for, including a print control.
 */
export function FileViewer({ file, onClose }: { file: ViewableFile | null; onClose: () => void }) {
  const open = file !== null;
  const pdf = file ? file.filename.toLowerCase().endsWith(".pdf") : false;

  return (
    <Dialog open={open} onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <DialogContent className="flex h-[88vh] max-w-[min(96vw,1100px)] flex-col gap-0 p-0 sm:max-w-[min(96vw,1100px)]">
        <DialogHeader className="flex-row items-center justify-between gap-4 border-b px-4 py-3">
          <div className="min-w-0">
            <DialogTitle className="truncate font-mono text-sm">{file?.filename}</DialogTitle>
            {file?.sessionTitle ? (
              <DialogDescription className="truncate text-xs">
                from {file.sessionTitle}
              </DialogDescription>
            ) : null}
          </div>

          {file ? (
            <div className="flex shrink-0 items-center gap-2">
              <a
                href={file.url}
                target="_blank"
                rel="noreferrer"
                className={buttonVariants({ variant: "ghost", size: "sm" })}
                title="Open in a new tab"
              >
                <ExternalLinkIcon />
              </a>
              <a
                href={`${file.url}?download=1`}
                className={buttonVariants({ variant: "outline", size: "sm" })}
              >
                <DownloadIcon />
                Save
              </a>
            </div>
          ) : null}
        </DialogHeader>

        <div className="bg-secondary/40 min-h-0 flex-1">
          {file && pdf ? (
            <iframe src={file.url} title={file.filename} className="h-full w-full border-0" />
          ) : file ? (
            <div className="flex h-full items-center justify-center overflow-auto p-4">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={file.url} alt={file.filename} className="max-h-full max-w-full" />
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * One file in a list. Viewable files open the viewer; everything else is a
 * plain download, because a spreadsheet in an iframe helps nobody.
 */
export function FileRow({
  filename,
  url,
  meta,
  onView,
}: {
  filename: string;
  url: string;
  meta?: React.ReactNode;
  onView?: (file: ViewableFile) => void;
}) {
  const viewable = isViewable(filename) && onView !== undefined;

  return (
    <div className="hover:bg-accent/40 flex items-center gap-3 px-4 py-2.5 transition-colors">
      <FileIcon className="text-muted-foreground size-4 shrink-0" />

      {viewable ? (
        <button
          type="button"
          onClick={() => onView({ filename, url })}
          className="min-w-0 flex-1 truncate text-left font-mono text-xs hover:underline"
        >
          {filename}
        </button>
      ) : (
        <a
          href={`${url}?download=1`}
          className="min-w-0 flex-1 truncate font-mono text-xs hover:underline"
        >
          {filename}
        </a>
      )}

      {meta ? <span className="text-muted-foreground shrink-0 text-xs">{meta}</span> : null}

      <a
        href={`${url}?download=1`}
        title={`Save ${filename}`}
        className={buttonVariants({ variant: "ghost", size: "icon" })}
      >
        <DownloadIcon />
      </a>
    </div>
  );
}

/** Holds the viewer's state for a list of files. */
export function useFileViewer() {
  const [file, setFile] = useState<ViewableFile | null>(null);
  return { file, open: setFile, close: () => setFile(null) };
}
