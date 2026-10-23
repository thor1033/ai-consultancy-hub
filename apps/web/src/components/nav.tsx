// Shared navigation model for the shell. Icons are square-cornered stroke
// glyphs drawn from the brand's geometry (rectangle = data, circle = human,
// stacked rectangles = knowledge, portal = access) — not a SaaS icon set.

export interface NavItem {
  href: string;
  label: string;
  icon: React.ReactNode;
}

const s = {
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "square" as const,
  strokeLinejoin: "miter" as const,
};

export const NAV: NavItem[] = [
  {
    href: "/",
    label: "Overview",
    icon: (
      <svg {...s}>
        <rect x="3" y="3" width="7" height="9" />
        <rect x="14" y="3" width="7" height="5" />
        <rect x="14" y="12" width="7" height="9" />
        <rect x="3" y="16" width="7" height="5" />
      </svg>
    ),
  },
  {
    href: "/knowledge",
    label: "Knowledge",
    icon: (
      // Stacked rectangles: the brand's symbol for knowledge / documents.
      <svg {...s}>
        <rect x="3" y="13" width="14" height="8" />
        <path d="M6 13V9h14v8h-3" />
        <path d="M9 9V5h12v8" />
      </svg>
    ),
  },
  {
    href: "/agents",
    label: "Agents",
    icon: (
      // Human (circle) with the blue duplicate offset — here as a second outline.
      <svg {...s}>
        <circle cx="10" cy="10" r="5" />
        <path d="M14 7.5a5 5 0 0 1 0 5" />
        <path d="M3 21v-1a7 7 0 0 1 7-7h0a7 7 0 0 1 7 7v1" />
      </svg>
    ),
  },
  {
    href: "/approvals",
    label: "Approvals",
    icon: (
      // A square with a tick inside: a decision a person makes.
      <svg {...s}>
        <rect x="3" y="3" width="18" height="18" />
        <path d="M7 12.5l3.5 3.5L17 9" />
      </svg>
    ),
  },
  {
    href: "/context",
    label: "Context",
    icon: (
      // A small network: nodes joined to a centre — what the agents hold.
      <svg {...s}>
        <rect x="10" y="10" width="4" height="4" />
        <rect x="3" y="4" width="3" height="3" />
        <rect x="18" y="4" width="3" height="3" />
        <rect x="3" y="17" width="3" height="3" />
        <rect x="18" y="17" width="3" height="3" />
        <path d="M6 6.5l4 4M18 6.5l-4 4M6 17.5l4-4M18 17.5l-4-4" />
      </svg>
    ),
  },
  {
    href: "/mcp",
    label: "MCP servers",
    icon: (
      <svg {...s}>
        <rect x="3" y="4" width="18" height="6" />
        <rect x="3" y="14" width="18" height="6" />
        <path d="M7 7h.01M7 17h.01" />
      </svg>
    ),
  },
  {
    href: "/admin",
    label: "Control plane",
    icon: (
      // Portal / arch: access.
      <svg {...s}>
        <path d="M4 21V11a8 8 0 0 1 16 0v10" />
        <path d="M4 21h16" />
        <path d="M9 21v-6h6v6" />
      </svg>
    ),
  },
];

export function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

/**
 * The brand lockup for the product: the typographic wordmark with the product
 * name beside it. The mark itself (assets/logo/mark-red.svg) is a supplied
 * asset the design system says never to redraw, so there is a slot for it,
 * not an imitation of it: drop the SVG into public/brand/mark-red.svg and set
 * `mark` to true.
 */
export function Wordmark({ mark = false, product = "AI hub" }: { mark?: boolean; product?: string }) {
  return (
    <span className="flex items-center gap-2.5">
      {mark && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src="/brand/mark-red.svg" alt="" width={14} height={14} className="shrink-0" />
      )}
      <span className="wordmark">Teqneo</span>
      <span className="wordmark-rule" aria-hidden />
      <span className="text-[0.8rem] font-medium text-[var(--text-soft)]">{product}</span>
    </span>
  );
}
