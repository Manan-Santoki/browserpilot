import { CheckIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A checkbox that looks like the rest of the console.
 *
 * A plain `<input type="checkbox">` is the one control here that still renders
 * as the browser's own, which reads as unfinished next to the Switch and
 * Select. This keeps the native input — so it posts in a form, is reachable by
 * keyboard, and needs no client component — and draws the box over it.
 */
export function Checkbox({
  className,
  ...props
}: React.ComponentProps<"input"> & { type?: never }) {
  return (
    <span className="relative inline-grid size-4 shrink-0 place-items-center">
      <input
        type="checkbox"
        className={cn(
          "peer border-input bg-background checked:border-signal checked:bg-signal focus-visible:ring-ring size-4 cursor-pointer appearance-none rounded-[5px] border transition-colors focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-offset-background focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      />
      <CheckIcon
        aria-hidden
        strokeWidth={3}
        className="text-signal-foreground pointer-events-none absolute size-3 opacity-0 peer-checked:opacity-100"
      />
    </span>
  );
}
