"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

type Props = {
  href: string;
  children: React.ReactNode;
  className?: string;
  activeClassName?: string;
};

/**
 * The layout remains a Server Component; only each link needs the current
 * pathname. Session detail routes belong to the Sessions item at `/`.
 */
export function AppNavLink({
  href,
  children,
  className,
  activeClassName = "bg-accent text-foreground font-medium",
}: Props) {
  const pathname = usePathname();
  const active =
    href === "/"
      ? pathname === "/" || pathname.startsWith("/sessions/")
      : pathname === href || pathname.startsWith(`${href}/`);

  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(className, active && activeClassName)}
    >
      {children}
    </Link>
  );
}
