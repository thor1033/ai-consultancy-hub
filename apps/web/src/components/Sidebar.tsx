"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV, isActive, Wordmark } from "./nav";
import { ThemeToggle } from "./ThemeToggle";
import { listMcpServersAction } from "@/app/mcp/actions";
import type { McpNavItem } from "@/app/mcp/types";

// The persistent rail (lg+). A slim MobileBar covers smaller screens.
// Paper-2 on paper, separated by a hairline — fill, not a frame.
export function Sidebar() {
  const pathname = usePathname();
  const [servers, setServers] = useState<McpNavItem[]>([]);

  // Live registries, so the rail always mirrors what's actually available.
  useEffect(() => {
    listMcpServersAction().then(setServers).catch(() => {});
  }, [pathname]);

  return (
    <aside className="fixed inset-y-0 left-0 z-40 hidden w-[15rem] flex-col overflow-y-auto border-r border-[var(--border)] bg-[var(--panel-2)] px-3 py-5 lg:flex">
      <Link href="/" className="px-1.5">
        <Wordmark />
      </Link>

      <nav className="mt-6 flex flex-col gap-0.5">
        {NAV.map((n) => (
          <Link key={n.href} href={n.href} data-active={isActive(pathname, n.href)} className="nav-item">
            <span className="opacity-90">{n.icon}</span>
            {n.label}
          </Link>
        ))}
      </nav>

      {servers.length > 0 && (
        <div className="mt-6">
          <div className="flex items-center justify-between px-1.5">
            <Link href="/mcp" className="eyebrow hover:text-[var(--brand)]">
              Servers
            </Link>
            <span className="mono text-[0.68rem] text-[var(--muted)]">{servers.length}</span>
          </div>
          <div className="mt-2 flex flex-col gap-0.5">
            {servers.map((s) => (
              <Link
                key={s.name}
                href={`/mcp/${s.name}`}
                data-active={pathname === `/mcp/${s.name}`}
                className="nav-item !py-1.5 !text-[0.82rem]"
                title={s.enabled ? "Enabled" : "Disabled"}
              >
                {/* Status node: blue = reachable, black at low weight = off. */}
                <span
                  className="dot shrink-0"
                  style={{
                    background: s.enabled ? "var(--ai)" : "var(--faint)",
                  }}
                />
                <span className="truncate">{s.label}</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      <div className="mt-auto flex flex-col gap-3 px-0.5 pt-6">
        <Link href="/agents/new" className="btn-brand w-full">
          New agent
        </Link>
        <div className="flex items-center justify-between border border-[var(--border)] bg-[var(--panel)] px-3 py-2">
          <span className="flex items-center gap-2 text-xs text-[var(--muted)]">
            <span className="dot bg-[var(--ai)]" />
            Online
          </span>
          <ThemeToggle />
        </div>
      </div>
    </aside>
  );
}
