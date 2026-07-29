"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { createSite, linkAccount, type FormState } from "./actions";

const initial: FormState = {};


function Feedback({ state }: { state: FormState }) {
  if (state.error) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {state.error}
      </p>
    );
  }
  if (state.success) {
    return <p className="text-sm text-running">{state.success}</p>;
  }
  return null;
}

export function AddSiteForm() {
  const [state, action, pending] = useActionState(createSite, initial);

  return (
    <form action={action} className="space-y-4">
      <div className="space-y-2">
        <Label  htmlFor="name">
          Name
        </Label>
        <Input id="name" name="name" required  placeholder="Acme ERP" />
      </div>

      <div className="space-y-2">
        <Label  htmlFor="baseUrl">
          URL
        </Label>
        <Input
          id="baseUrl"
          name="baseUrl"
          required
          
          placeholder="https://erp.example.com"
        />
      </div>

      <div className="space-y-2">
        <Label  htmlFor="cookieName">
          Session cookie name
        </Label>
        <Input
          id="cookieName"
          name="cookieName"
          required
          
          placeholder="app-session"
        />
        <p className="mt-1 text-xs text-muted-foreground">
          The cookie the target application reads to identify a logged-in user.
        </p>
      </div>

      <div className="space-y-2">
        <Label  htmlFor="secret">
          Signing secret
        </Label>
        <Input id="secret" name="secret" type="password" required  />
      </div>

      <div className="space-y-2">
        <Label  htmlFor="notes">
          Notes for the agent <span className="text-muted-foreground font-normal">(optional)</span>
        </Label>
        <Textarea
          id="notes"
          name="notes"
          rows={3}
          
          placeholder="Purchase orders live at /purchase-orders. Suppliers are called vendors here."
        />
        <p className="mt-1 text-xs text-muted-foreground">
          Domain vocabulary and useful routes. This goes into the agent&apos;s instructions.
        </p>
      </div>

      <Feedback state={state} />

      <Button type="submit" disabled={pending} >
        {pending ? "Registering…" : "Register site"}
      </Button>
    </form>
  );
}

export function LinkAccountForm({
  siteProfileId,
  siteName,
}: {
  siteProfileId: string;
  siteName: string;
}) {
  const [state, action, pending] = useActionState(linkAccount, initial);

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="siteProfileId" value={siteProfileId} />

      <p className="text-sm text-muted-foreground">
        These are your details <em>on {siteName}</em>, not your BrowserPilot login. The robot signs
        in as this person, so that application&apos;s own records show your name.
      </p>

      <div className="space-y-2">
        <Label  htmlFor={`targetUserId-${siteProfileId}`}>
          User ID on {siteName}
        </Label>
        <Input
          id={`targetUserId-${siteProfileId}`}
          name="targetUserId"
          required
          
          placeholder="3f7c1a52-9d4e-4b1a-8f2c-1a2b3c4d5e6f"
        />
      </div>

      <div className="space-y-2">
        <Label  htmlFor={`targetEmail-${siteProfileId}`}>
          Email there
        </Label>
        <Input
          id={`targetEmail-${siteProfileId}`}
          name="targetEmail"
          type="email"
          required
        />
      </div>

      <div className="space-y-2">
        <Label  htmlFor={`targetName-${siteProfileId}`}>
          Name there
        </Label>
        <Input id={`targetName-${siteProfileId}`} name="targetName" required  />
      </div>

      <div className="space-y-2">
        <Label  htmlFor={`targetRole-${siteProfileId}`}>
          Role there <span className="text-muted-foreground font-normal">(optional)</span>
        </Label>
        <Input
          id={`targetRole-${siteProfileId}`}
          name="targetRole"
          
          placeholder="admin"
        />
      </div>

      <Feedback state={state} />

      <Button type="submit" disabled={pending} >
        {pending ? "Saving…" : "Save my account"}
      </Button>
    </form>
  );
}
