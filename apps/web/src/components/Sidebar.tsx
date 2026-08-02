"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV, isActive, Logo } from "./nav";
import { ThemeToggle } from "./ThemeToggle";
import { listMcpServersAction } from "@/app/mcp/actions";
import type { McpNavItem } from "@/app/mcp/types";

// The persistent command rail (lg+). A slim MobileBar covers smaller screens.
export function Sidebar() {
  const pathname = usePathname();
  const [servers, setServers] = useState<McpNavItem[]>([]);

  // Live MCP registry, so the rail always mirrors what's actually available.
  useEffect(() => {
    listMcpServersAction().then(setServers).catch(() => {});
  }, [pathname]);

  return (
    <aside className="fixed inset-y-0 left-0 z-40 hidden w-[15rem] flex-col overflow-y-auto border-r border-[var(--border)] bg-[var(--panel-2)] px-3 py-4 lg:flex">
      <Link href="/" className="flex items-center gap-2.5 px-1.5">
        <Logo />
        <span className="text-[0.95rem] font-semibold tracking-tight">
          AI&nbsp;<span className="text-gradient">Hub</span>
        </span>
      </Link>

      <div className="mt-1.5 px-1.5 text-[0.68rem] uppercase tracking-[0.14em] text-[var(--muted)]">
        Console
      </div>

      <nav className="mt-2 flex flex-col gap-0.5">
        {NAV.map((n) => (
          <Link key={n.href} href={n.href} data-active={isActive(pathname, n.href)} className="nav-item">
            <span className="opacity-90">{n.icon}</span>
            {n.label}
          </Link>
        ))}
      </nav>

      {servers.length > 0 && (
        <div className="mt-4">
          <div className="flex items-center justify-between px-1.5">
            <Link
              href="/mcp"
              className="text-[0.68rem] uppercase tracking-[0.14em] text-[var(--muted)] hover:text-[var(--text)]"
            >
              MCP servers
            </Link>
            <span className="mono text-[0.68rem] text-[var(--muted)]">{servers.length}</span>
          </div>
          <div className="mt-1.5 flex flex-col gap-0.5">
            {servers.map((s) => (
              <Link
                key={s.name}
                href={`/mcp/${s.name}`}
                data-active={pathname === `/mcp/${s.name}`}
                className="nav-item !py-1.5 !text-[0.82rem]"
                title={s.enabled ? "Enabled" : "Disabled"}
              >
                <span
                  className="dot shrink-0"
                  style={{
                    background: s.enabled ? "var(--positive)" : "var(--muted)",
                    color: s.enabled ? "var(--positive)" : "var(--muted)",
                    opacity: s.enabled ? 1 : 0.5,
                  }}
                />
                <span className="truncate">{s.label}</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      <div className="mt-auto flex flex-col gap-3 px-0.5 pt-4">
        <Link href="/workbench" className="btn-brand w-full">
          + Skillify a workflow
        </Link>
        <div className="flex items-center justify-between rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2">
          <span className="flex items-center gap-2 text-xs text-[var(--muted)]">
            <span className="dot text-[var(--positive)] bg-[var(--positive)]" />
            Online
          </span>
          <ThemeToggle />
        </div>
      </div>
    </aside>
  );
}
