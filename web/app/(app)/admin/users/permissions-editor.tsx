"use client";

import { useState, useTransition } from "react";
import { PERMISSIONS, PERMISSION_LABELS } from "@browserpilot/core";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { setUserPermissions } from "../actions";

type Props = {
  userId: string;
  /** Current granular permissions. An admin needs none — the role implies all. */
  perms: string[];
  /** The person's role, so the editor can say when permissions are redundant. */
  role: "ADMIN" | "USER";
  /** Named in the dialog, so it is obvious whose permissions are being edited. */
  name: string;
};

export function PermissionsEditor({ userId, perms, role, name }: Props) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string[]>(perms);
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  const save = () => {
    startTransition(async () => {
      const data = new FormData();
      data.set("userId", userId);
      data.set("permissions", draft.join(","));
      await setUserPermissions(data);
      setMessage("Saved.");
      setOpen(false);
    });
  };

  const toggle = (permission: string, checked: boolean) => {
    setDraft((d) => (checked ? [...d, permission] : d.filter((p) => p !== permission)));
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" variant="ghost" />}>
        {role === "ADMIN" ? (
          "Full admin"
        ) : perms.length === 0 ? (
          "No permissions"
        ) : (
          <Badge variant="outline" className="bg-transparent font-normal">
            {perms.length} permission{perms.length === 1 ? "" : "s"}
          </Badge>
        )}
      </DialogTrigger>

      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>What {name} may do</DialogTitle>
          <DialogDescription>
            An administrator has every permission regardless of these rows. They refine what a
            User may do.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2.5">
          {PERMISSIONS.map((permission) => (
            <label
              key={permission}
              className="flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2 text-sm transition-colors hover:bg-accent/50"
            >
              <Checkbox
                checked={draft.includes(permission)}
                disabled={role === "ADMIN"}
                onChange={(e) => toggle(permission, e.target.checked)}
              />
              <span className="flex-1">{PERMISSION_LABELS[permission]}</span>
              <code className="text-muted-foreground text-[10px]">{permission}</code>
            </label>
          ))}
        </div>

        <DialogFooter>
          <Button onClick={() => setOpen(false)} variant="ghost">
            Cancel
          </Button>
          <Button onClick={save} disabled={pending || role === "ADMIN"}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
