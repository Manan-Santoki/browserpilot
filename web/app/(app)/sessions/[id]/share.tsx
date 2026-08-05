"use client";

import { useActionState } from "react";
import { UsersIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { shareSession, unshareSession, type ShareState } from "../actions";

type Share = {
  userId: string;
  name: string;
  email: string;
  createdAt: Date;
};

const initial: ShareState = {};

/**
 * Sharing, folded into the session's own header.
 *
 * It was a full card above the browser, so the first thing on the page was a
 * form for something most sessions never do — and the thing the page is
 * actually for started below the fold. As a control it stays available and
 * says how many people can see this, which is the part worth being visible.
 */
export function SharePanel({ sessionId, shares }: { sessionId: string; shares: Share[] }) {
  const [state, action, pending] = useActionState(shareSession, initial);

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button variant="outline" aria-label="Share this session">
            <UsersIcon />
            {shares.length === 0 ? "Share" : `Shared with ${shares.length}`}
          </Button>
        }
      />
      <PopoverContent align="end" className="w-80 space-y-3">
        <div>
          <p className="text-sm font-medium">Share this session</p>
          <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
            They can watch the browser and read the conversation. They cannot type, approve, or
            stop it.
          </p>
        </div>

        {shares.length > 0 ? (
          <ul className="divide-border border-border divide-y rounded-lg border text-sm">
            {shares.map((share) => (
              <li key={share.userId} className="flex items-center gap-2 px-2.5 py-1.5">
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium">{share.name}</span>
                  <span className="text-muted-foreground ml-1.5 truncate font-mono text-xs">
                    {share.email}
                  </span>
                </span>
                <form action={unshareSession}>
                  <input type="hidden" name="sessionId" value={sessionId} />
                  <input type="hidden" name="userId" value={share.userId} />
                  <Button type="submit" size="sm" variant="ghost">
                    Remove
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        ) : null}

        <form action={action} className="space-y-2">
          <Label htmlFor={`share-email-${sessionId}`} className="text-xs">
            Their email address
          </Label>
          <div className="flex items-center gap-2">
            <Input
              id={`share-email-${sessionId}`}
              name="email"
              type="email"
              placeholder="name@example.com"
              required
              className="min-w-0 flex-1"
            />
            <input type="hidden" name="sessionId" value={sessionId} />
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? "Sharing…" : "Share"}
            </Button>
          </div>
        </form>

        {state.error ? (
          <p role="alert" className="text-destructive text-xs">
            {state.error}
          </p>
        ) : null}
        {state.success ? <p className="text-running text-xs">{state.success}</p> : null}
      </PopoverContent>
    </Popover>
  );
}
