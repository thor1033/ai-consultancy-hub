/*
 * Views: how much of the hub a person is shown (docs/views.md).
 *
 * The hub's backend is the same for everyone: agents with tools and memory,
 * a knowledge base, approvals, schedules, hand-offs, patterns, run timings.
 * Who may DO what is the roles' (packages/authz). How much of it a person
 * SEES is this: a per-person view, chosen by them, that hides and never
 * grants. A partner at a client firm asks questions, runs a skill and
 * approves what an agent wants to change; the person who builds the firm's
 * agents wants every dial. Both are served by the same pages.
 *
 *   simple ..... ask, run a skill, approve, add a document. Plain words, no
 *                internals: no costs, models, tool names, JSON or settings.
 *   standard ... everything a champion needs to run the hub for colleagues:
 *                set up agents, skills, schedules and knowledge, with the
 *                deep dials folded under "Advanced".
 *   expert ..... everything: connections, run timings, hand-offs, the raw
 *                calls, the control plane.
 *
 * Pure and client-safe: the resolution order and the rules live here, so the
 * server, the client components and verify-views.mjs share one source.
 */

export type View = "simple" | "standard" | "expert";
export const VIEWS: readonly View[] = ["simple", "standard", "expert"];
export const VIEW_COOKIE = "hub-view";

export function isView(value: unknown): value is View {
  return value === "simple" || value === "standard" || value === "expert";
}

/** Whether `view` shows at least as much as `min`. */
export function atLeast(view: View, min: View): boolean {
  return VIEWS.indexOf(view) >= VIEWS.indexOf(min);
}

export const VIEW_INFO: Record<View, { label: string; tagline: string; who: string; shows: string[] }> = {
  simple: {
    label: "Simple",
    tagline: "Ask, run, approve.",
    who: "For everyone who uses the agents rather than builds them.",
    shows: [
      "A home page with your agents, what is waiting for you, and your documents",
      "Talk to an agent, or run one of its skills from a short form",
      "Approve or reject what an agent wants to change, in plain words",
      "Add and search documents",
    ],
  },
  standard: {
    label: "Standard",
    tagline: "Run the hub for your colleagues.",
    who: "For the person in the firm who sets the agents up.",
    shows: [
      "Everything in Simple, and the overview of what the hub has done",
      "Create and change agents, their skills, schedules and memory",
      "Collections, sources and the context map",
      "Deeper dials — model, tool rounds, where it runs — folded under Advanced",
    ],
  },
  expert: {
    label: "Expert",
    tagline: "Every dial.",
    who: "For whoever builds and runs the hub itself.",
    shows: [
      "Everything in Standard, with Advanced open",
      "MCP servers, the control plane, hand-offs between agents",
      "Where each run's time went, tokens, models and cost per answer",
      "The exact calls an agent wants to make, as JSON",
    ],
  },
};

/** The view a person starts with when nobody has chosen: by what they may do. */
export function defaultViewForRoles(roles: readonly string[]): View {
  if (roles.includes("admin")) return "expert";
  if (roles.includes("analyst")) return "standard";
  return "simple";
}

export type ViewSource = "you" | "deployment" | "role";

/**
 * The view to show, and where it came from. A person's own choice wins (the
 * browser's cookie, then the one saved on their row, so it follows them to a
 * new device); then the deployment's default (HUB_DEFAULT_VIEW — a client's
 * hub can start everyone in Simple); then what their role suggests. A value
 * that is not a view is ignored at every step, never trusted.
 */
export function resolveView(input: { cookie?: unknown; saved?: unknown; deployment?: unknown; roles?: readonly string[] }): { view: View; from: ViewSource } {
  if (isView(input.cookie)) return { view: input.cookie, from: "you" };
  if (isView(input.saved)) return { view: input.saved, from: "you" };
  const deployment = typeof input.deployment === "string" ? input.deployment.trim().toLowerCase() : undefined;
  if (isView(deployment)) return { view: deployment, from: "deployment" };
  return { view: defaultViewForRoles(input.roles ?? []), from: "role" };
}

/** What the signed-in person may do, as the shell needs it. Mirrors authz actions. */
export interface Can {
  run: boolean;
  manage: boolean;
  admin: boolean;
  write: boolean;
}

export const CAN_NOTHING: Can = { run: false, manage: false, admin: false, write: false };

export interface NavSpec {
  href: string;
  /** Label in each view; a missing view means the item is hidden there. */
  labels: Partial<Record<View, string>>;
  /** A permission the item needs, beyond being signed in. */
  needs?: keyof Can;
}

/**
 * The navigation, by view. Pages stay reachable by address whatever the
 * view — a view is not a permission — but the rail shows only what the view
 * is for. "MCP servers" is "Connections" until Expert, and "Control plane" is
 * "Admin": the same pages, in the words of whoever is looking.
 */
export const NAV_SPEC: readonly NavSpec[] = [
  { href: "/", labels: { simple: "Home", standard: "Overview", expert: "Overview" } },
  { href: "/agents", labels: { simple: "Agents", standard: "Agents", expert: "Agents" } },
  { href: "/approvals", labels: { simple: "Approvals", standard: "Approvals", expert: "Approvals" }, needs: "run" },
  { href: "/knowledge", labels: { simple: "Documents", standard: "Knowledge", expert: "Knowledge" } },
  { href: "/decks", labels: { simple: "Decks", standard: "Decks", expert: "Decks" }, needs: "run" },
  { href: "/context", labels: { standard: "Context", expert: "Context" }, needs: "run" },
  { href: "/mcp", labels: { standard: "Connections", expert: "MCP servers" } },
  { href: "/admin", labels: { standard: "Admin", expert: "Control plane" }, needs: "admin" },
  { href: "/settings", labels: { simple: "Settings", standard: "Settings", expert: "Settings" } },
];

export function navFor(view: View, can: Can): { href: string; label: string }[] {
  return NAV_SPEC.filter((n) => n.labels[view] && (!n.needs || can[n.needs])).map((n) => ({ href: n.href, label: n.labels[view]! }));
}
