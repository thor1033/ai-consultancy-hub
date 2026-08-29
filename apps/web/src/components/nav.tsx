// Shared navigation model for the command-center shell. Icons are compact
// stroke glyphs so the sidebar reads as a tool, not a marketing menu.

export interface NavItem {
  href: string;
  label: string;
  icon: React.ReactNode;
}

const s = {
  width: 17,
  height: 17,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export const NAV: NavItem[] = [
  {
    href: "/",
    label: "Overview",
    icon: (
      <svg {...s}>
        <rect x="3" y="3" width="7" height="9" rx="1.5" />
        <rect x="14" y="3" width="7" height="5" rx="1.5" />
        <rect x="14" y="12" width="7" height="9" rx="1.5" />
        <rect x="3" y="16" width="7" height="5" rx="1.5" />
      </svg>
    ),
  },
  {
    href: "/knowledge",
    label: "Knowledge",
    icon: (
      <svg {...s}>
        <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z" />
        <path d="M4 5.5V20.5" />
      </svg>
    ),
  },
  {
    href: "/agents",
    label: "Agents",
    icon: (
      <svg {...s}>
        <rect x="5" y="8" width="14" height="11" rx="2.5" />
        <path d="M12 8V4.5M9.5 13h.01M14.5 13h.01M2.5 12v3M21.5 12v3" />
      </svg>
    ),
  },
  {
    href: "/mcp",
    label: "MCP servers",
    icon: (
      <svg {...s}>
        <rect x="3" y="4" width="18" height="6" rx="1.5" />
        <rect x="3" y="14" width="18" height="6" rx="1.5" />
        <path d="M7 7h.01M7 17h.01" />
      </svg>
    ),
  },
  {
    href: "/roi",
    label: "Return on AI",
    icon: (
      <svg {...s}>
        <path d="M3 3v18h18" />
        <path d="M7 15l4-5 3 3 4-6" />
      </svg>
    ),
  },
  {
    href: "/admin",
    label: "Control plane",
    icon: (
      <svg {...s}>
        <path d="M12 3l7 4v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V7z" />
        <path d="M9.5 12l1.8 1.8 3.2-3.6" />
      </svg>
    ),
  },
  {
    href: "/assessment",
    label: "Assessment",
    icon: (
      <svg {...s}>
        <path d="M9 3h6a1 1 0 0 1 1 1v1h1a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h1V4a1 1 0 0 1 1-1z" />
        <path d="M9 12l2 2 4-4" />
      </svg>
    ),
  },
  {
    href: "/chat",
    label: "Chat",
    icon: (
      <svg {...s}>
        <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H9l-4 3.5v-3.5H5.5A1.5 1.5 0 0 1 4 14.5z" />
      </svg>
    ),
  },
  {
    href: "/workbench",
    label: "Workbench",
    icon: (
      <svg {...s}>
        <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4l-6 6L5 19.7l6-6a4 4 0 0 0 5.4-5.4l-2.3 2.3-2-2z" />
      </svg>
    ),
  },
  {
    href: "/pptx",
    label: "PowerPoint",
    icon: (
      <svg {...s}>
        <rect x="4" y="3" width="16" height="18" rx="1.5" />
        <path d="M8 8h5a2.5 2.5 0 0 1 0 5H8z" />
        <path d="M8 13v4" />
      </svg>
    ),
  },
];

export function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

export function Logo({ size = 30 }: { size?: number }) {
  return (
    <span
      className="brand-gradient relative grid place-items-center rounded-[0.55rem]"
      style={{ width: size, height: size }}
    >
      <svg width={size * 0.56} height={size * 0.56} viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 3l2.1 5.1L19 10l-4.9 1.9L12 17l-2.1-5.1L5 10l4.9-1.9z" />
      </svg>
    </span>
  );
}
