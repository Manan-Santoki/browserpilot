"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createSite, linkAccount, type FormState } from "./actions";

const STRATEGIES = [
  { value: "persistent_profile", label: "People sign in themselves" },
  { value: "cookie_mint", label: "We hold the signing secret" },
];

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
  // Which fields matter depends entirely on how the robot will get in, so the
  // form asks that first and then shows only what that answer needs.
  const [strategy, setStrategy] = useState("persistent_profile");
  const mints = strategy === "cookie_mint";

  return (
    <form action={action} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="loginStrategy">How does the robot get in?</Label>
        <Select
          name="loginStrategy"
          value={strategy}
          onValueChange={(v) => setStrategy(v ?? "persistent_profile")}
          items={STRATEGIES}
        >
          <SelectTrigger id="loginStrategy" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STRATEGIES.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-muted-foreground text-xs">
          {mints
            ? "For applications you run. We forge a session with the app's own signing secret, so it never expires and each person keeps their own identity."
            : "For anything else. Each person signs in once in a browser we run, and we keep the profile that login leaves behind."}
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="name">Name</Label>
        <Input id="name" name="name" required placeholder="Acme ERP" />
      </div>

      <div className="space-y-2">
        <Label htmlFor="baseUrl">URL</Label>
        <Input id="baseUrl" name="baseUrl" required placeholder="https://erp.example.com" />
      </div>

      {mints ? (
        <>
          <div className="space-y-2">
            <Label htmlFor="cookieName">Session cookie name</Label>
            <Input id="cookieName" name="cookieName" required placeholder="app-session" />
            <p className="text-muted-foreground text-xs">
              The cookie the target application reads to identify a signed-in user.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="secret">Signing secret</Label>
            <Input id="secret" name="secret" type="password" required />
            <p className="text-muted-foreground text-xs">
              Must match the target application&apos;s own session secret. It is encrypted before
              it is stored.
            </p>
          </div>
        </>
      ) : (
        <div className="space-y-2">
          <Label htmlFor="loggedOutPattern">
            Signed-out page <span className="text-muted-foreground font-normal">(optional)</span>
          </Label>
          <Input id="loggedOutPattern" name="loggedOutPattern" placeholder="/login" />
          <p className="text-muted-foreground text-xs">
            How we recognise that a saved sign-in has expired. Leave this empty unless the site
            sends you somewhere unusual — the common sign-in paths are already known.
          </p>
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="notes">
          Notes for the agent <span className="text-muted-foreground font-normal">(optional)</span>
        </Label>
        <Textarea
          id="notes"
          name="notes"
          rows={3}
          placeholder="Purchase orders live at /purchase-orders. Suppliers are called vendors here."
        />
        <p className="text-muted-foreground text-xs">
          Domain vocabulary and useful routes. This goes into the agent&apos;s instructions.
        </p>
      </div>

      <Feedback state={state} />

      <Button type="submit" disabled={pending}>
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
