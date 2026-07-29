"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { login, type LoginState } from "./actions";

const initial: LoginState = {};

export default function LoginPage() {
  const [state, formAction, pending] = useActionState(login, initial);

  return (
    <main className="flex min-h-screen">
      {/* The left panel states what the product does. No stock illustration:
          the thesis is the robot asking permission, so say that. */}
      <section className="bg-sidebar hidden w-[46%] flex-col justify-between border-r p-10 lg:flex">
        <div className="flex items-baseline gap-2">
          <span className="text-signal font-mono">▚</span>
          <span className="text-sm font-semibold tracking-tight">BrowserPilot</span>
        </div>

        <div className="max-w-md">
          <h2 className="text-2xl leading-snug font-semibold tracking-tight">
            A browser that works for you, and checks before it acts.
          </h2>
          <p className="text-muted-foreground mt-4 text-sm leading-relaxed">
            Sessions run on the server, so you can start one here and pick it up on your phone.
            You see what the robot is doing, and it waits for you before anything destructive.
          </p>
        </div>

        <dl className="text-muted-foreground grid grid-cols-3 gap-4 font-mono text-xs">
          <div>
            <dt className="text-foreground">Live</dt>
            <dd>watch it work</dd>
          </div>
          <div>
            <dt className="text-signal">Asks</dt>
            <dd>before it deletes</dd>
          </div>
          <div>
            <dt className="text-foreground">Kept</dt>
            <dd>chat and files</dd>
          </div>
        </dl>
      </section>

      <section className="flex flex-1 items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-8 lg:hidden">
            <span className="text-signal font-mono">▚</span>
            <span className="ml-2 text-sm font-semibold tracking-tight">BrowserPilot</span>
          </div>

          <h1 className="text-xl font-semibold tracking-tight">Sign in</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Accounts are created by invitation.
          </p>

          <form action={formAction} className="mt-8 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" name="email" type="email" autoComplete="email" required autoFocus />
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
              />
            </div>

            {state.error ? (
              <p role="alert" className="text-destructive text-sm">
                {state.error}
              </p>
            ) : null}

            <Button type="submit" disabled={pending} className="w-full">
              {pending ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        </div>
      </section>
    </main>
  );
}
