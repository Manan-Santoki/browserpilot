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
import type { ModelChoice } from "@browserpilot/core";
import { startSession, type StartState } from "./sessions/actions";

const initial: StartState = {};

/** Falls through to whatever an admin has saved as the default. */
const USE_DEFAULT: ModelChoice = { value: "default", label: "Default model" };

type Props = {
  sites: Array<{ id: string; name: string }>;
  /**
   * What this deployment's provider serves, from the server. Hardcoding the
   * Claude line-up here meant a deployment pointed at a gateway offered three
   * models it would 404 on, with nothing on screen to say so.
   */
  models: ModelChoice[];
};

export function StartSessionForm({ sites, models }: Props) {
  const [state, action, pending] = useActionState(startSession, initial);

  const modelItems = [USE_DEFAULT, ...models];

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

      {/* One entry means there is nothing to choose between — the admin's
          default is the only option, so the picker is noise. */}
      {modelItems.length > 1 ? (
        <Select name="model" defaultValue="default" items={modelItems}>
          <SelectTrigger className="w-[170px]" aria-label="Model">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {modelItems.map((model) => (
              <SelectItem key={model.value} value={model.value}>
                {model.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}

      <Input name="title" placeholder="What is this for?" className="w-52" />

      <Button type="submit" disabled={pending}>
        {pending ? "Starting…" : "New session"}
      </Button>

      {state.error ? (
        <p role="alert" className="text-destructive w-full text-sm">
          {state.error}
          {state.signInSiteId ? (
            <>
              {" "}
              <Link href="/sites" className="underline underline-offset-4">
                Go to Sites to sign in
              </Link>
              .
            </>
          ) : null}
        </p>
      ) : null}
    </form>
  );
}
