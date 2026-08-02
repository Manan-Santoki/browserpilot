"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

type Tab = {
  href: string;
  label: string;
};

/**
 * The admin section rail.
 *
 * Underlined rather than pilled, and sitting *on* a hairline that runs the
 * full content width: that line is what anchors the tabs to the page. As
 * floating chips they read as controls belonging to nothing, and duplicated
 * the sidebar's own "Admin" entry instead of extending it.
 */
export function AdminTabs({ tabs }: { tabs: Tab[] }) {
  const pathname = usePathname();

  return (
    <nav aria-label="Admin sections" className="border-border flex gap-6 overflow-x-auto border-b [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {tabs.map((tab) => {
        // "/admin" must match only the overview, not every admin page.
        const active =
          tab.href === "/admin" ? pathname === "/admin" : pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "hover:text-foreground -mb-px shrink-0 border-b-2 border-transparent pb-2.5 text-sm font-medium transition-colors",
              active ? "border-signal text-foreground" : "text-muted-foreground",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
