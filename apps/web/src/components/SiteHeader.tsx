"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ThemeToggle } from "./ThemeToggle";

const NAV = [
  { href: "/", label: "Skills" },
  { href: "/knowledge", label: "Knowledge" },
  { href: "/roi", label: "Return on AI" },
  { href: "/admin", label: "Control plane" },
  { href: "/assessment", label: "Assessment" },
];

export function SiteHeader() {
  const pathname = usePathname();
  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <header className="sticky top-0 z-50 px-4 pt-4">
      <div className="glass sheen mx-auto flex max-w-6xl items-center gap-3 rounded-2xl px-4 py-2.5">
        <Link href="/" className="flex items-center gap-2.5">
          <Logo />
          <span className="text-[0.95rem] font-semibold tracking-tight">
            AI&nbsp;<span className="text-gradient">Hub</span>
          </span>
        </Link>

        <nav className="ml-4 hidden items-center gap-1 md:flex">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={`rounded-lg px-3 py-1.5 text-sm transition ${
                isActive(n.href)
                  ? "bg-[var(--surface-strong)] text-[var(--text)] shadow-[inset_0_1px_0_0_var(--highlight)]"
                  : "text-[var(--muted)] hover:text-[var(--text)]"
              }`}
            >
              {n.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <Link href="/workbench" className="btn-brand hidden sm:inline-flex">
            <PlusIcon />
            Skillify
          </Link>
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}

function Logo() {
  return (
    <span className="relative grid h-8 w-8 place-items-center">
      <span className="brand-gradient absolute inset-0 rounded-[0.6rem] opacity-90 blur-[6px]" />
      <span className="brand-gradient relative grid h-8 w-8 place-items-center rounded-[0.6rem]">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3l2.2 5.2L20 10l-5.8 1.8L12 17l-2.2-5.2L4 10l5.8-1.8z" />
        </svg>
      </span>
    </span>
  );
}

function PlusIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
