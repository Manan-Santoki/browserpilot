"use client";

import Link from "next/link";
import { useActionState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { startSession, type StartState } from "./sessions/actions";

const initial: StartState = {};

const MODELS = [
  { value: "default", label: "Default model" },
  { value: "claude-opus-5", label: "Opus 5 · most capable" },
  { value: "claude-sonnet-5", label: "Sonnet 5 · faster" },
  { value: "claude-haiku-4-5", label: "Haiku 4.5 · fastest" },
];

export function StartSessionForm({ sites }: { sites: Array<{ id: string; name: string }> }) {
  const [state, action, pending] = useActionState(startSession, initial);

  if (sites.length === 0) {
    return (
      <Link href="/sites" className={buttonVariants({ variant: "outline" })}>
        Set up a site first
      </Link>
    );
  }

  // Base UI shows the raw value in the trigger unless the root is given the
  // value→label mapping, which is how a site id leaked into the button.
  const siteItems = sites.map((site) => ({ value: site.id, label: site.name }));

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      {/* The Select posts through a hidden input, so name= is on the root. */}
      <Select name="siteProfileId" defaultValue={sites[0]!.id} items={siteItems}>
        <SelectTrigger className="w-[168px]" aria-label="Site">
          <SelectValue placeholder="Site" />
        </SelectTrigger>
        <SelectContent>
          {sites.map((site) => (
            <SelectItem key={site.id} value={site.id}>
              {site.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select name="model" defaultValue="default" items={MODELS}>
        <SelectTrigger className="w-[170px]" aria-label="Model">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {MODELS.map((model) => (
            <SelectItem key={model.value} value={model.value}>
              {model.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Input name="title" placeholder="What is this for?" className="w-52" />

      <Button type="submit" disabled={pending}>
        {pending ? "Starting…" : "New session"}
      </Button>

      {state.error ? (
        <p role="alert" className="text-destructive w-full text-sm">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
