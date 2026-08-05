"use client";

import { useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import type { ChatItem } from "@/lib/transcript";

/**
 * The robot's own working, folded up.
 *
 * A single request can produce twenty tool lines — snapshot, click, snapshot,
 * type, snapshot — interleaved with the two sentences of prose that are the
 * actual answer. Left flat, the answer is lost in the log of how it was
 * reached. Collapsed, the transcript reads as a conversation again, and the
 * working is one click away when a step needs checking.
 */

/**
 * Every tool item is folded into a cluster, so none reaches the item branch —
 * and saying so in the type is what lets the renderer narrow on `kind` without
 * a dead case for something that cannot arrive.
 */
export type TranscriptEntry =
  | { kind: "item"; key: string; item: Exclude<ChatItem, { kind: "tool" }> }
  | { kind: "tools"; key: string; lines: string[] };

/**
 * Fold runs of tool activity into single entries, and give every row a key
 * that survives new events arriving.
 *
 * Array indices were the keys, so appending to the transcript re-keyed
 * everything after the insertion point and React rebuilt rows that had not
 * changed — losing the open/closed state of anything interactive among them.
 */
export function groupTools(items: ChatItem[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];

  items.forEach((item, index) => {
    if (item.kind === "tool") {
      const last = entries.at(-1);
      if (last?.kind === "tools") {
        last.lines.push(item.text);
        return;
      }
      entries.push({ kind: "tools", key: `tools-${index}`, lines: [item.text] });
      return;
    }
    entries.push({ kind: "item", key: `${item.kind}-${index}`, item });
  });

  return entries;
}

/** A run of browser actions, summarised until asked. */
export function ToolCluster({ lines }: { lines: string[] }) {
  const [open, setOpen] = useState(false);

  // One action is not a cluster — hiding it behind a disclosure costs a click
  // and saves nothing.
  if (lines.length === 1) {
    return (
      <p className="text-muted-foreground/80 font-mono text-xs">
        <span className="text-muted-foreground/50 mr-2">›</span>
        {lines[0]}
      </p>
    );
  }

  return (
    <div className="text-muted-foreground/80 font-mono text-xs">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="hover:text-foreground flex items-center gap-1 transition-colors"
      >
        <ChevronRightIcon
          aria-hidden
          className={`size-3 transition-transform ${open ? "rotate-90" : ""}`}
        />
        {lines.length} browser actions
      </button>

      {open ? (
        <ul className="border-border/60 mt-1.5 ml-1.5 space-y-1 border-l pl-3">
          {lines.map((line, i) => (
            <li key={`${line}-${i}`}>{line}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
