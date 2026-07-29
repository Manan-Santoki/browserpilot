"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { saveSettings, type AdminState } from "../actions";

const initial: AdminState = {};


export function SettingsForm({
  current,
}: {
  current: {
    perUserSessionLimit: number;
    globalSessionLimit: number;
    idleTimeoutMs: number;
    hardCapMs: number;
    defaultModel: string;
  };
}) {
  const [state, action, pending] = useActionState(saveSettings, initial);

  const rows: Array<{ key: keyof typeof current; label: string; hint: string }> = [
    {
      key: "perUserSessionLimit",
      label: "Browsers per person",
      hint: "How many one person may run at the same time.",
    },
    {
      key: "globalSessionLimit",
      label: "Browsers in total",
      hint: "Across everyone. Bounded by this server's memory.",
    },
    {
      key: "idleTimeoutMs",
      label: "Idle timeout (ms)",
      hint: "A session with no activity for this long is stopped. 600000 is ten minutes.",
    },
    {
      key: "hardCapMs",
      label: "Maximum lifetime (ms)",
      hint: "A session is stopped after this long however busy it is. 3600000 is one hour.",
    },
  ];

  return (
    <form action={action} className="space-y-5">
      {rows.map((row) => (
        <div key={row.key}>
          <Label htmlFor={row.key} >
            {row.label}
          </Label>
          <Input
            id={row.key}
            name={row.key}
            type="number"
            min={1}
            defaultValue={current[row.key] as number}
          />
          <p className="mt-1 text-xs text-muted-foreground">{row.hint}</p>
        </div>
      ))}

      <div className="space-y-2">
        <Label htmlFor="defaultModel">
          Model
        </Label>
        <Input
          id="defaultModel"
          name="defaultModel"
          defaultValue={current.defaultModel}
        />
        <p className="mt-1 text-xs text-muted-foreground">
          Applies to sessions started from now on; running sessions keep the model they began with.
        </p>
      </div>

      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}
      {state.success ? (
        <p className="text-sm text-running">{state.success}</p>
      ) : null}

      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save limits"}
      </Button>
    </form>
  );
}
