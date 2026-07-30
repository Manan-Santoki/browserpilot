import { AgentMarkdown } from "@/components/agent-markdown";
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
      <p className="text-muted-foreground text-sm">Nothing was said in this session.</p>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border px-4 py-4 text-sm">
      {items.map((item, i) => {
        if (item.kind === "you") {
          return (
            <p key={i} className="text-right">
              <span className="bg-secondary text-secondary-foreground inline-block max-w-[85%] rounded-lg px-3 py-1.5 text-left">
                {item.text}
              </span>
            </p>
          );
        }
        if (item.kind === "agent") {
          return <AgentMarkdown key={i}>{item.text}</AgentMarkdown>;
        }
        if (item.kind === "tool") {
          return (
            <p key={i} className="text-muted-foreground/80 font-mono text-xs">
              {item.text}
            </p>
          );
        }
        if (item.kind === "error") {
          return (
            <p key={i} className="text-destructive">
              {item.text}
            </p>
          );
        }
        if (item.kind === "file") {
          return (
            <p key={i}>
              <a
                href={item.url}
                className="bg-secondary hover:bg-accent inline-flex items-center gap-2 rounded-md px-3 py-1.5 font-mono text-xs transition-colors"
              >
                <span aria-hidden>↓</span>
                {item.filename}
              </a>
            </p>
          );
        }
        if (item.kind === "screenshot") {
          return (
            <a key={i} href={item.url} target="_blank" rel="noreferrer" className="block">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={item.url}
                alt={`Screenshot of the page — ${item.filename}`}
                className="max-h-72 w-auto rounded-lg border transition-opacity hover:opacity-90"
              />
            </a>
          );
        }
        if (item.kind === "choice") {
          return (
            <div key={i} className="border-signal/30 bg-signal/5 rounded-lg border px-3 py-2.5">
              <p className="text-foreground">{item.question}</p>
              <p className="text-muted-foreground mt-1 text-xs">
                {item.resolved ? `Selected: ${item.resolved.label}` : "No option was selected."}
              </p>
            </div>
          );
        }
        return (
          <p key={i} className="text-signal font-mono text-xs">
            {item.summary} — {item.resolved ?? "never answered"}
          </p>
        );
      })}
    </div>
  );
}
