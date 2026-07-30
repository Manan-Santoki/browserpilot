import { cn } from "@/lib/utils";

/** Plain-language names for the states, in the user's terms rather than ours. */
const LABELS: Record<string, string> = {
  starting: "starting",
  idle: "ready",
  working: "working",
  awaiting_approval: "needs you",
  stopped: "stopped",
  failed: "failed",
  interrupted: "interrupted",
  connecting: "connecting",
  disconnected: "disconnected",
};

function lampClass(status: string, live: boolean): string {
  if (status === "working" || status === "starting") return "lamp-working";
  if (status === "awaiting_approval") return "lamp-waiting";
  if (status === "idle") return live ? "lamp-ready" : "lamp-idle";
  if (status === "connecting") return "lamp-idle";
  return "lamp-off";
}

export function StatusLamp({
  status,
  live = false,
  className,
}: {
  status: string;
  live?: boolean;
  className?: string;
}) {
  return <span className={cn("lamp", lampClass(status, live), className)} aria-hidden />;
}

export function StatusLabel({
  status,
  live = false,
  className,
}: {
  status: string;
  live?: boolean;
  className?: string;
}) {
  const label = LABELS[status] ?? status;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 text-sm",
        status === "awaiting_approval" ? "text-signal" : "text-muted-foreground",
        className,
      )}
    >
      <StatusLamp status={status} live={live} />
      {label}
    </span>
  );
}
