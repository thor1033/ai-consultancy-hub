"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV, isActive, Logo } from "./nav";
import { ThemeToggle } from "./ThemeToggle";

// Compact top bar for < lg: logo + horizontally scrollable nav + theme toggle.
export function MobileBar() {
  const pathname = usePathname();

  return (
    <div className="sticky top-0 z-40 border-b border-[var(--border)] bg-[var(--panel-2)]/90 backdrop-blur lg:hidden">
      <div className="flex items-center gap-3 px-4 py-2.5">
        <Link href="/" className="flex items-center gap-2">
          <Logo size={26} />
          <span className="text-sm font-semibold tracking-tight">
            AI&nbsp;<span className="text-gradient">Hub</span>
          </span>
        </Link>
        <div className="ml-auto">
          <ThemeToggle />
        </div>
      </div>
      <nav className="flex gap-1 overflow-x-auto px-3 pb-2 [scrollbar-width:none]">
        {NAV.map((n) => (
          <Link
            key={n.href}
            href={n.href}
            data-active={isActive(pathname, n.href)}
            className="nav-item shrink-0 whitespace-nowrap !py-1.5 !text-[0.8rem]"
          >
            {n.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
