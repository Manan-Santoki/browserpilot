"use client";

import { useActionState } from "react";
import type { ModelChoice } from "@browserpilot/core";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { saveSettings, type AdminState } from "../actions";
import { AdminSaveBar, AdminSection } from "../shell";

const initial: AdminState = {};

/** Milliseconds → whole minutes for the input's value. */
function toMinutes(ms: number): number {
  return Math.max(1, Math.round(ms / 60_000));
}

export function SettingsForm({
  current,
  models,
}: {
  current: {
    perUserSessionLimit: number;
    globalSessionLimit: number;
    idleTimeoutMs: number;
    hardCapMs: number;
    defaultModel: string;
  };
  /** What this deployment's provider serves. */
  models: ModelChoice[];
}) {
  const [state, action, pending] = useActionState(saveSettings, initial);

  const rows: Array<{
    key: keyof typeof current;
    label: string;
    hint: string;
    suffix?: string;
    min?: number;
  }> = [
    {
      key: "perUserSessionLimit",
      label: "Browsers per person",
      hint: "How many one person may run at the same time.",
      min: 1,
    },
    {
      key: "globalSessionLimit",
      label: "Browsers in total",
      hint: "Across everyone. Bounded by this server's memory.",
      min: 1,
    },
    {
      key: "idleTimeoutMs",
      label: "Idle timeout",
      hint: "A session with no activity for this long is stopped.",
      suffix: "minutes",
      min: 1,
    },
    {
      key: "hardCapMs",
      label: "Maximum lifetime",
      hint: "A session is stopped after this long however busy it is.",
      suffix: "minutes",
      min: 1,
    },
  ];

  return (
    <form action={action} className="space-y-6">
      <AdminSection
        title="Concurrency & timeouts"
        description="Each running browser costs roughly 200–400 MB of memory, so the global limit is really a statement about this server's RAM."
      >
        <div className="grid gap-5 sm:grid-cols-2">
          {rows.map((row) => (
            <div key={row.key}>
              <Label htmlFor={row.key}>{row.label}</Label>
              <div className="relative">
                <Input
                  id={row.key}
                  name={row.key}
                  type="number"
                  min={row.min ?? 1}
                  defaultValue={
                    row.key === "idleTimeoutMs" || row.key === "hardCapMs"
                      ? toMinutes(current[row.key] as number)
                      : (current[row.key] as number)
                  }
                />
                {row.suffix ? (
                  <span className="text-muted-foreground pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs">
                    {row.suffix}
                  </span>
                ) : null}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{row.hint}</p>
            </div>
          ))}
        </div>
      </AdminSection>

      <AdminSection
        title="Default model"
        description="Applies to sessions started from now on; running sessions keep the model they began with."
      >
        {/* A picker rather than a text field: the failure mode this replaces
            was a typo'd model id that only surfaced as a failed session. With
            nothing configured, fall back to free text so an admin editing a
            half-configured deployment is not locked out. */}
        {models.length > 0 ? (
          <Select name="defaultModel" defaultValue={current.defaultModel} items={models}>
            <SelectTrigger id="defaultModel" className="w-full" aria-label="Model">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {models.map((model) => (
                <SelectItem key={model.value} value={model.value}>
                  {model.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Input id="defaultModel" name="defaultModel" defaultValue={current.defaultModel} />
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          These are the models on offer, set on the Models page.
        </p>
      </AdminSection>

      <AdminSaveBar pending={pending} label="Save limits" error={state.error} success={state.success} />
    </form>
  );
}
