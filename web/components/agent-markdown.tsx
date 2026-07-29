import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * The agent's replies, rendered as the markdown they actually are.
 *
 * It writes headings, bold, lists and the occasional table; shown as plain text
 * those arrive as literal asterisks and pipes, which is how the transcript read
 * before this existed. react-markdown does not pass raw HTML through, so an
 * instruction the agent picked up off a page cannot inject markup here.
 *
 * The element styles are set here rather than through a typography plugin so
 * the density matches the rest of the console — this is an operations log, not
 * an article.
 */
export function AgentMarkdown({ children }: { children: string }) {
  return (
    <div className="space-y-2 text-sm leading-relaxed break-words">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="whitespace-pre-wrap">{children}</p>,
          strong: ({ children }) => (
            <strong className="text-foreground font-semibold">{children}</strong>
          ),
          em: ({ children }) => <em className="italic">{children}</em>,
          ul: ({ children }) => (
            <ul className="list-disc space-y-1 pl-5 marker:text-muted-foreground">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal space-y-1 pl-5 marker:text-muted-foreground">{children}</ol>
          ),
          li: ({ children }) => <li className="pl-0.5">{children}</li>,
          h1: ({ children }) => <h3 className="mt-3 font-semibold">{children}</h3>,
          h2: ({ children }) => <h3 className="mt-3 font-semibold">{children}</h3>,
          h3: ({ children }) => <h4 className="mt-3 font-medium">{children}</h4>,
          h4: ({ children }) => <h4 className="mt-3 font-medium">{children}</h4>,
          code: ({ children }) => (
            <code className="bg-secondary rounded px-1 py-0.5 font-mono text-[0.85em]">
              {children}
            </code>
          ),
          pre: ({ children }) => (
            <pre className="bg-secondary overflow-x-auto rounded-md p-3 font-mono text-xs">
              {children}
            </pre>
          ),
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-signal underline underline-offset-2"
            >
              {children}
            </a>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-border text-muted-foreground border-l-2 pl-3">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="border-border my-3" />,
          // Wide tables scroll on their own rather than stretching the column.
          table: ({ children }) => (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-xs">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border-border text-muted-foreground border-b px-2 py-1 text-left font-medium">
              {children}
            </th>
          ),
          td: ({ children }) => <td className="border-border/60 border-b px-2 py-1">{children}</td>,
        }}
      >
        {children}
      </Markdown>
    </div>
  );
}
