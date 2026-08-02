"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { shareSession, unshareSession, type ShareState } from "../actions";

type Share = {
  userId: string;
  name: string;
  email: string;
  createdAt: Date;
};

const initial: ShareState = {};

export function SharePanel({ sessionId, shares }: { sessionId: string; shares: Share[] }) {
  const [state, action, pending] = useActionState(shareSession, initial);

  return (
    <Card className="py-0">
      <CardHeader className="py-4">
        <CardTitle className="text-base">Share</CardTitle>
        <CardDescription>
          Anyone you share with can watch this session — its browser and its conversation — but
          cannot type, approve, or stop it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 pb-4">
        {shares.length > 0 ? (
          <ul className="divide-y divide-border rounded-lg border text-sm">
            {shares.map((share) => (
              <li
                key={share.userId}
                className="flex items-center gap-2 px-3 py-2"
              >
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium">{share.name}</span>
                  <span className="text-muted-foreground ml-2 truncate font-mono text-xs">
                    {share.email}
                  </span>
                </span>
                <form action={unshareSession}>
                  <input type="hidden" name="sessionId" value={sessionId} />
                  <input type="hidden" name="userId" value={share.userId} />
                  <Button type="submit" size="sm" variant="ghost">
                    Stop sharing
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground text-sm">Not shared with anyone yet.</p>
        )}

        <form action={action} className="flex items-end gap-2">
          <div className="min-w-0 flex-1 space-y-1.5">
            <Label htmlFor={`share-email-${sessionId}`}>Share with</Label>
            <Input
              id={`share-email-${sessionId}`}
              name="email"
              type="email"
              placeholder="name@example.com"
              required
            />
          </div>
          <input type="hidden" name="sessionId" value={sessionId} />
          <Button type="submit" disabled={pending}>
            Share
          </Button>
        </form>

        {state.error ? (
          <p role="alert" className="text-destructive text-sm">
            {state.error}
          </p>
        ) : null}
        {state.success ? (
          <p className="text-running text-sm">{state.success}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
