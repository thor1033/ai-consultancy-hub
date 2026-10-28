"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV, isActive, Wordmark, WaitingBadge } from "./nav";
import { waitingOnMeAction } from "@/app/approvals/actions";
import { ThemeToggle } from "./ThemeToggle";

// Compact top bar for < lg: wordmark + horizontally scrollable nav + theme
// toggle. Solid paper-2; the system has no blur.
export function MobileBar() {
  const pathname = usePathname();
  const [waiting, setWaiting] = useState(0);
  useEffect(() => {
    waitingOnMeAction().then(setWaiting).catch(() => {});
  }, [pathname]);

  return (
    <div className="sticky top-0 z-40 border-b border-[var(--border)] bg-[var(--panel-2)] lg:hidden">
      <div className="flex items-center gap-3 px-4 py-2.5">
        <Link href="/">
          <Wordmark />
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
            {n.href === "/approvals" && <WaitingBadge count={waiting} />}
          </Link>
        ))}
      </nav>
    </div>
  );
}
