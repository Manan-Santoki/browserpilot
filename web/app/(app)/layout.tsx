import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { logout } from "./actions";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();

  return (
    <div className="min-h-screen">
      <header className="border-b border-neutral-200 dark:border-neutral-800">
        <div className="mx-auto flex max-w-7xl items-center gap-6 px-6 py-3">
          <Link href="/" className="text-sm font-semibold tracking-tight">
            BrowserPilot
          </Link>

          <nav className="flex items-center gap-4 text-sm text-neutral-600 dark:text-neutral-400">
            <Link href="/" className="hover:text-neutral-900 dark:hover:text-neutral-100">
              Sessions
            </Link>
            <Link href="/sites" className="hover:text-neutral-900 dark:hover:text-neutral-100">
              Sites
            </Link>
            <Link href="/devices" className="hover:text-neutral-900 dark:hover:text-neutral-100">
              Devices
            </Link>
            {user.role === "ADMIN" ? (
              <Link href="/admin" className="hover:text-neutral-900 dark:hover:text-neutral-100">
                Admin
              </Link>
            ) : null}
          </nav>

          <div className="ml-auto flex items-center gap-3 text-sm">
            <span className="text-neutral-500 dark:text-neutral-400">{user.name}</span>
            <form action={logout}>
              <button
                type="submit"
                className="text-neutral-500 underline-offset-4 hover:underline dark:text-neutral-400"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-8">{children}</main>
    </div>
  );
}
