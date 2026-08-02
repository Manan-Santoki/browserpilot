import type { ReactNode } from "react";

/**
 * The shared furniture of the admin section.
 *
 * Admin is a small instrument panel for one operator, and it should read as
 * one instrument rather than six pages that happen to share a sidebar. Two
 * rules do most of that work:
 *
 * 1. **One spine.** The layout owns the content width; a page never sets its
 *    own. Every title, rail and card starts at the same left edge, so moving
 *    between pages does not move the furniture. (This is what was broken:
 *    five pages, five different `max-w-*`, each centring independently.)
 * 2. **State before form.** Every page opens with the same rail of live facts.
 *    People arrive at a config page asking "is it working?", and the rail
 *    answers before the form asks anything.
 */

/** Page title and its one line of intent. */
export function AdminHeader({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="max-w-xl">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        <p className="text-muted-foreground mt-1.5 text-sm leading-relaxed">{description}</p>
      </div>
      {children}
    </div>
  );
}

export type StatusItem = {
  label: string;
  value: string;
  /**
   * What the lamp says.
   *
   * `ok` is a lit green lamp, not a grey one. The app's lamp vocabulary is
   * deliberate — stillness means nothing needs you — but a *working* provider
   * is a positive fact and has to look like one.
   */
  tone?: "ok" | "warn" | "bad" | "idle";
  /** A few words of evidence: how it was proven, or why it is not fine. */
  hint?: string;
};

const LAMP: Record<NonNullable<StatusItem["tone"]>, string> = {
  ok: "lamp lamp-ready",
  warn: "lamp lamp-waiting",
  bad: "lamp lamp-off",
  idle: "lamp lamp-idle",
};

/**
 * The rail of live facts every admin page opens with.
 *
 * Deliberately not a card: it is a reading off the panel, not another thing to
 * fill in, and giving it card chrome made it compete with the form below it.
 * Values are monospaced because they are machine values — endpoints, model
 * ids, bucket names — and that is how the rest of the console shows them.
 */
export function AdminStatus({ items }: { items: StatusItem[] }) {
  return (
    <dl className="border-border grid gap-x-10 gap-y-4 border-y py-4 sm:grid-cols-2">
      {items.map((item) => (
        <div key={item.label} className="min-w-0">
          <dt className="text-muted-foreground font-mono text-[0.6875rem] tracking-wider uppercase">
            {item.label}
          </dt>
          <dd className="mt-1.5 flex items-baseline gap-2">
            <span aria-hidden className={`${LAMP[item.tone ?? "idle"]} translate-y-[-1px]`} />
            <span className="min-w-0 truncate text-sm font-medium">{item.value}</span>
            {item.hint ? (
              <span className="text-muted-foreground min-w-0 truncate text-xs">{item.hint}</span>
            ) : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * One block of a config form.
 *
 * Plain and quiet on purpose. An earlier pass numbered these as steps, which
 * implied an order that only sometimes exists — and next to the status rail it
 * was one device too many.
 */
export function AdminSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="border-border rounded-xl border">
      <div className="border-border border-b px-5 py-4">
        <h2 className="text-sm font-semibold">{title}</h2>
        {description ? (
          <p className="text-muted-foreground mt-1 max-w-2xl text-sm leading-relaxed">
            {description}
          </p>
        ) : null}
      </div>
      <div className="px-5 py-5">{children}</div>
    </section>
  );
}

/** A labelled group of rows inside a section, used where a list needs a name. */
export function AdminEyebrow({ children }: { children: ReactNode }) {
  return (
    <h3 className="text-muted-foreground font-mono text-[0.6875rem] tracking-wider uppercase">
      {children}
    </h3>
  );
}

/**
 * The save row every config form ends with.
 *
 * Sticky, because these forms are long enough that the button scrolls out of
 * sight on a laptop — and a change you cannot see how to save reads as a
 * change that did not take.
 */
export function AdminSaveBar({
  pending,
  pendingLabel = "Saving…",
  label,
  error,
  success,
}: {
  pending: boolean;
  pendingLabel?: string;
  label: string;
  error?: string;
  success?: string;
}) {
  return (
    <div className="bg-background/85 border-border sticky bottom-0 -mx-1 flex flex-wrap items-center gap-x-4 gap-y-2 border-t px-1 py-3 backdrop-blur">
      <button
        type="submit"
        disabled={pending}
        className="bg-foreground text-background hover:bg-foreground/90 focus-visible:ring-ring inline-flex h-9 shrink-0 items-center justify-center rounded-lg px-4 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:opacity-50"
      >
        {pending ? pendingLabel : label}
      </button>
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
      {success ? <p className="text-running text-sm">{success}</p> : null}
    </div>
  );
}
