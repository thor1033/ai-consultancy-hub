"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { isActive, Wordmark, WaitingBadge, navIcon } from "./nav";
import { ThemeToggle } from "./ThemeToggle";
import { ViewSwitch } from "./ViewSwitch";
import { useView } from "./ViewProvider";
import { navFor } from "@/lib/views";
import { listMcpServersAction } from "@/app/mcp/actions";
import type { McpNavItem } from "@/app/mcp/types";
import { waitingOnMeAction } from "@/app/approvals/actions";

// The persistent rail (lg+). A slim MobileBar covers smaller screens.
// Paper-2 on paper, separated by a hairline — fill, not a frame. What it
// lists is the person's view (docs/views.md): Simple shows the five places a
// person who uses agents goes; Expert adds the servers and the control plane.
export function Sidebar() {
  const pathname = usePathname();
  const { view, can } = useView();
  const [servers, setServers] = useState<McpNavItem[]>([]);
  const [waiting, setWaiting] = useState(0);
  const items = navFor(view, can);

  // Live registries, so the rail always mirrors what's actually available.
  // The approvals count is re-read on every navigation and every minute, so a
  // write a colleague sends shows up without a reload. The server list is an
  // Expert's: nobody else is shown it, so nobody else pays for the lookup.
  useEffect(() => {
    if (view === "expert") listMcpServersAction().then(setServers).catch(() => {});
    if (can.run) waitingOnMeAction().then(setWaiting).catch(() => {});
  }, [pathname, view, can.run]);
  useEffect(() => {
    if (!can.run) return;
    const t = setInterval(() => waitingOnMeAction().then(setWaiting).catch(() => {}), 60_000);
    return () => clearInterval(t);
  }, [can.run]);

  return (
    <aside className="fixed inset-y-0 left-0 z-40 hidden w-[15rem] flex-col overflow-y-auto border-r border-[var(--border)] bg-[var(--panel-2)] px-3 py-5 lg:flex">
      <Link href="/" className="px-1.5">
        <Wordmark />
      </Link>

      <nav className="mt-6 flex flex-col gap-0.5">
        {items.map((n) => (
          <Link key={n.href} href={n.href} data-active={isActive(pathname, n.href)} className="nav-item">
            <span className="opacity-90">{navIcon(n.href)}</span>
            {n.label}
            {n.href === "/approvals" && <WaitingBadge count={waiting} />}
          </Link>
        ))}
      </nav>

      {view === "expert" && servers.length > 0 && (
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
        {view !== "simple" && can.manage && (
          <Link href="/agents/new" className="btn-brand w-full">
            New agent
          </Link>
        )}
        <div>
          <div className="eyebrow mb-1.5 px-0.5">View</div>
          <ViewSwitch />
        </div>
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
