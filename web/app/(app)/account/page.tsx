import { requireUser } from "@/lib/auth";
import { setLanguage } from "./actions";
import { PasswordForm } from "./password-form";

export default async function AccountPage() {
  const user = await requireUser();

  return (
    <div className="max-w-lg space-y-10">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Account</h1>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          {user.name} · {user.email} · {user.role === "ADMIN" ? "administrator" : "user"}
        </p>
      </div>

      <section>
        <h2 className="text-base font-medium">Change password</h2>
        <div className="mt-4">
          <PasswordForm />
        </div>
      </section>

      <section>
        <h2 className="text-base font-medium">Speech language</h2>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          The default for push-to-talk. You can still switch it per recording.
        </p>
        <form action={setLanguage} className="mt-3 flex items-center gap-2">
          <select
            name="language"
            defaultValue={user.preferredLanguage}
            className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          >
            <option value="en">English</option>
            <option value="hi">हिन्दी</option>
            <option value="gu">ગુજરાતી</option>
          </select>
          <button
            type="submit"
            className="rounded-md border border-neutral-300 px-3 py-2 text-sm font-medium hover:bg-neutral-50 dark:border-neutral-600 dark:hover:bg-neutral-900"
          >
            Save
          </button>
        </form>
      </section>
    </div>
  );
}
