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

function lampClass(status: string): string {
  if (status === "working" || status === "starting") return "lamp-working";
  if (status === "awaiting_approval") return "lamp-waiting";
  if (status === "idle" || status === "connecting") return "lamp-idle";
  return "lamp-off";
}

export function StatusLamp({ status, className }: { status: string; className?: string }) {
  return <span className={cn("lamp", lampClass(status), className)} aria-hidden />;
}

export function StatusLabel({ status, className }: { status: string; className?: string }) {
  const label = LABELS[status] ?? status;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 text-sm",
        status === "awaiting_approval" ? "text-signal" : "text-muted-foreground",
        className,
      )}
    >
      <StatusLamp status={status} />
      {label}
    </span>
  );
}
