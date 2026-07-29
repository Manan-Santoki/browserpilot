"use client";

import { useActionState } from "react";
import { createSite, linkAccount, type FormState } from "./actions";

const initial: FormState = {};

const field =
  "w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:focus:border-neutral-400";
const label = "mb-1.5 block text-sm font-medium";
const button =
  "rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50 dark:bg-white dark:text-neutral-900";

function Feedback({ state }: { state: FormState }) {
  if (state.error) {
    return (
      <p role="alert" className="text-sm text-red-600 dark:text-red-400">
        {state.error}
      </p>
    );
  }
  if (state.success) {
    return <p className="text-sm text-green-700 dark:text-green-400">{state.success}</p>;
  }
  return null;
}

export function AddSiteForm() {
  const [state, action, pending] = useActionState(createSite, initial);

  return (
    <form action={action} className="space-y-4">
      <div>
        <label className={label} htmlFor="name">
          Name
        </label>
        <input id="name" name="name" required className={field} placeholder="Acme ERP" />
      </div>

      <div>
        <label className={label} htmlFor="baseUrl">
          URL
        </label>
        <input
          id="baseUrl"
          name="baseUrl"
          required
          className={field}
          placeholder="https://erp.example.com"
        />
      </div>

      <div>
        <label className={label} htmlFor="cookieName">
          Session cookie name
        </label>
        <input
          id="cookieName"
          name="cookieName"
          required
          className={field}
          placeholder="app-session"
        />
        <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
          The cookie the target application reads to identify a logged-in user.
        </p>
      </div>

      <div>
        <label className={label} htmlFor="secret">
          Signing secret
        </label>
        <input id="secret" name="secret" type="password" required className={field} />
      </div>

      <div>
        <label className={label} htmlFor="notes">
          Notes for the agent <span className="font-normal text-neutral-500">(optional)</span>
        </label>
        <textarea
          id="notes"
          name="notes"
          rows={3}
          className={field}
          placeholder="Purchase orders live at /purchase-orders. Suppliers are called vendors here."
        />
        <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
          Domain vocabulary and useful routes. This goes into the agent&apos;s instructions.
        </p>
      </div>

      <Feedback state={state} />

      <button type="submit" disabled={pending} className={button}>
        {pending ? "Registering…" : "Register site"}
      </button>
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

      <p className="text-sm text-neutral-500 dark:text-neutral-400">
        These are your details <em>on {siteName}</em>, not your BrowserPilot login. The robot signs
        in as this person, so that application&apos;s own records show your name.
      </p>

      <div>
        <label className={label} htmlFor={`targetUserId-${siteProfileId}`}>
          User ID on {siteName}
        </label>
        <input
          id={`targetUserId-${siteProfileId}`}
          name="targetUserId"
          required
          className={field}
          placeholder="3f7c1a52-9d4e-4b1a-8f2c-1a2b3c4d5e6f"
        />
      </div>

      <div>
        <label className={label} htmlFor={`targetEmail-${siteProfileId}`}>
          Email there
        </label>
        <input
          id={`targetEmail-${siteProfileId}`}
          name="targetEmail"
          type="email"
          required
          className={field}
        />
      </div>

      <div>
        <label className={label} htmlFor={`targetName-${siteProfileId}`}>
          Name there
        </label>
        <input id={`targetName-${siteProfileId}`} name="targetName" required className={field} />
      </div>

      <div>
        <label className={label} htmlFor={`targetRole-${siteProfileId}`}>
          Role there <span className="font-normal text-neutral-500">(optional)</span>
        </label>
        <input
          id={`targetRole-${siteProfileId}`}
          name="targetRole"
          className={field}
          placeholder="admin"
        />
      </div>

      <Feedback state={state} />

      <button type="submit" disabled={pending} className={button}>
        {pending ? "Saving…" : "Save my account"}
      </button>
    </form>
  );
}
