import Link from "next/link";
import { hasAdminAccess, requireUser } from "@/lib/auth";
import { Separator } from "@/components/ui/separator";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppNavLink } from "@/components/app-nav-link";
import { logout } from "./actions";

const NAV = [
  { href: "/", label: "Sessions" },
  { href: "/files", label: "Files" },
  { href: "/sites", label: "Sites" },
  { href: "/devices", label: "Devices" },
];

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const adminAccess = hasAdminAccess(user);

  // One provider for the whole console: it is what shares the open/close
  // delay between tooltips, so moving between two adjacent controls does not
  // replay the delay on each.
  return (
    <TooltipProvider delay={300}>
    <div className="flex h-screen overflow-hidden">
      {/* A left rail rather than a top bar: a console is navigated rarely and
          watched constantly, so navigation should sit out of the way. */}
      <aside className="bg-sidebar hidden w-56 shrink-0 flex-col border-r md:flex">
        <div className="px-5 py-5">
          <Link href="/" className="flex items-baseline gap-2">
            <span className="text-signal font-mono text-sm">▚</span>
            <span className="text-[15px] font-semibold tracking-tight">BrowserPilot</span>
          </Link>
          <p className="text-muted-foreground mt-1 text-xs">Robots at the controls</p>
        </div>

        <Separator />

        <nav className="flex flex-1 flex-col gap-0.5 p-3">
          {NAV.map((item) => (
            <AppNavLink
              key={item.href}
              href={item.href}
              className="text-muted-foreground hover:bg-accent hover:text-foreground rounded-md px-3 py-2 text-sm transition-colors"
            >
              {item.label}
            </AppNavLink>
          ))}

          {adminAccess ? (
            <>
              <Separator className="my-2" />
              <AppNavLink
                href="/admin"
                className="text-muted-foreground hover:bg-accent hover:text-foreground rounded-md px-3 py-2 text-sm transition-colors"
              >
                Admin
              </AppNavLink>
            </>
          ) : null}
        </nav>

        <Separator />

        <div className="p-3">
          <AppNavLink
            href="/account"
            className="hover:bg-accent block rounded-md px-3 py-2 transition-colors"
          >
            <span className="block truncate text-sm font-medium">{user.name}</span>
            <span className="text-muted-foreground block truncate text-xs">
              {user.role === "ADMIN" ? "Administrator" : "User"}
            </span>
          </AppNavLink>
          <form action={logout}>
            <button
              type="submit"
              className="text-muted-foreground hover:text-foreground w-full rounded-md px-3 py-1.5 text-left text-xs transition-colors"
            >
              Sign out
            </button>
          </form>
        </div>
      </aside>

      {/* Mobile: the rail collapses to a strip of links. */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-4 border-b px-4 py-3 md:hidden">
          <Link href="/" className="text-sm font-semibold">
            <span className="text-signal font-mono">▚</span> BrowserPilot
          </Link>
          <nav className="text-muted-foreground flex gap-3 overflow-x-auto text-sm">
            {NAV.map((item) => (
              <AppNavLink
                key={item.href}
                href={item.href}
                className="whitespace-nowrap"
                activeClassName="text-foreground font-medium"
              >
                {item.label}
              </AppNavLink>
            ))}
            {adminAccess ? (
              <AppNavLink href="/admin" activeClassName="text-foreground font-medium">
                Admin
              </AppNavLink>
            ) : null}
            <AppNavLink href="/account" activeClassName="text-foreground font-medium">
              Account
            </AppNavLink>
          </nav>
        </header>

        <main className="w-full min-h-0 flex-1 overflow-y-auto px-4 py-6 md:px-8 md:py-8">
          {children}
        </main>
      </div>
    </div>
    </TooltipProvider>
  );
}
