"use client";

import { useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

type Props = {
  /** Server action to run on confirm. Hidden fields are posted with it. */
  action: (formData: FormData) => void | Promise<void>;
  fields?: Record<string, string>;
  /** Text on the button that opens the dialog. */
  label: string;
  title: string;
  description: string;
  /** Text on the button that carries out the action. Defaults to `label`. */
  confirmLabel?: string;
  destructive?: boolean;
  size?: "sm" | "default";
  variant?: "default" | "outline" | "ghost" | "secondary" | "destructive";
  /**
   * Render the trigger as a menu item instead of a standalone button, for use
   * inside a DropdownMenu.
   */
  dropdown?: boolean;
};

/**
 * The single way this app asks "are you sure?".
 *
 * Every irreversible action routes through here rather than through the
 * browser's own confirm(), which cannot be styled, blocks the page, and looks
 * like it came from a different application. Keeping one component also keeps
 * the wording consistent: the dialog always says what will happen, and the
 * confirming button repeats the verb from the button that opened it.
 */
export function ConfirmAction({
  action,
  fields,
  label,
  title,
  description,
  confirmLabel,
  destructive,
  size = "sm",
  variant,
  dropdown,
}: Props) {
  const [open, setOpen] = useState(false);

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger
        render={
          dropdown ? (
            <button
              type="button"
              className={`flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground ${
                destructive
                  ? "text-destructive focus:bg-destructive/10 focus:text-destructive"
                  : ""
              }`}
            >
              {label}
            </button>
          ) : (
            <Button
              size={size}
              variant={variant ?? (destructive ? "ghost" : "outline")}
              className={destructive ? "text-destructive hover:text-destructive" : undefined}
            />
          )
        }
      >
        {label}
      </AlertDialogTrigger>

      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>

        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <form action={action} onSubmit={() => setOpen(false)}>
            {Object.entries(fields ?? {}).map(([name, value]) => (
              <input key={name} type="hidden" name={name} value={value} />
            ))}
            {/* Solid, not the tinted destructive variant: the one button that
                cannot be undone should not read as disabled. */}
            <AlertDialogAction
              type="submit"
              className={
                destructive ? "bg-destructive text-background hover:bg-destructive/85" : undefined
              }
            >
              {confirmLabel ?? label}
            </AlertDialogAction>
          </form>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
