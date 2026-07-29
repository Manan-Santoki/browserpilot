"use client";

import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { RemoteBrowser } from "./remote-browser";

type Props = {
  sessionId: string;
  siteProfileId: string;
  siteName: string;
  save: (formData: FormData) => Promise<void>;
};

export function SignInPanel({ sessionId, siteProfileId, siteName, save }: Props) {
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);

  // Identity-stable so the socket is not torn down and rebuilt on every render.
  const onReady = useCallback((value: boolean) => setReady(value), []);

  return (
    <Card className="gap-0 py-0">
      <CardContent className="p-4">
        <RemoteBrowser sessionId={sessionId} onReady={onReady} />
      </CardContent>

      <CardFooter className="flex-wrap items-center gap-3 border-t px-4 py-3">
        <form action={save} onSubmit={() => setSaving(true)}>
          <input type="hidden" name="sessionId" value={sessionId} />
          <input type="hidden" name="siteProfileId" value={siteProfileId} />
          <Button type="submit" disabled={!ready || saving}>
            {saving ? "Saving…" : "Save this sign-in"}
          </Button>
        </form>

        <p className="text-muted-foreground text-sm">
          {saving
            ? "Closing the browser so it writes everything down."
            : ready
              ? `Press this once you are signed in to ${siteName}.`
              : "Waiting for the browser…"}
        </p>
      </CardFooter>
    </Card>
  );
}
