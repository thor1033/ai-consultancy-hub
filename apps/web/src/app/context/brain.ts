// Geometry for the Context map: the brain's outline, its stipple, the neuron
// network, where each piece of context sits, and the cascades that fire into
// the agent. Pure and deterministic, so the server and the browser draw the
// same brain and a refresh does not reshuffle it.

export type Region = "projects" | "people" | "rules" | "routines";

export const VIEW = { x: 40, y: 50, w: 940, h: 580 };
export const CORE = { x: 500, y: 310 };
export const KNOWLEDGE_BOX = { x: 150, y: 262, w: 104, h: 76 };

export const REGIONS: Record<Region, { x: number; y: number; label: string; lx: number; ly: number; anchor: "start" | "end" }> = {
  projects: { x: 340, y: 205, label: "PROJECTS", lx: 130, ly: 112, anchor: "start" },
  people: { x: 690, y: 215, label: "PEOPLE", lx: 880, ly: 124, anchor: "end" },
  rules: { x: 345, y: 440, label: "RULES", lx: 130, ly: 560, anchor: "start" },
  routines: { x: 700, y: 445, label: "ROUTINES", lx: 880, ly: 600, anchor: "end" },
};

export function inBrain(x: number, y: number): boolean {
  const e = (cx: number, cy: number, rx: number, ry: number) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
  if (e(500, 280, 400, 215) || e(270, 300, 190, 190) || e(740, 290, 200, 185)) return true;
  if (e(430, 410, 250, 105) || e(720, 470, 135, 80)) return true;
  if (y > 440 && y < 600) {
    const mid = 600 - (y - 440) * 0.05;
    const half = 34 - (y - 440) * 0.08;
    if (Math.abs(x - mid) < half) return true;
  }
  return false;
}

const inKnowledgeBox = (x: number, y: number, pad = 0) =>
  x > KNOWLEDGE_BOX.x - pad &&
  x < KNOWLEDGE_BOX.x + KNOWLEDGE_BOX.w + pad &&
  y > KNOWLEDGE_BOX.y - pad &&
  y < KNOWLEDGE_BOX.y + KNOWLEDGE_BOX.h + pad;

function rng(seed: number) {
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Point {
  x: number;
  y: number;
  j: number;
}

export function stipple(count: number): Point[] {
  const r = rng(7);
  const pts: Point[] = [];
  let tries = 0;
  while (pts.length < count && tries < count * 6) {
    tries++;
    const x = 80 + r() * 860;
    const y = 60 + r() * 560;
    if (!inBrain(x, y) || inKnowledgeBox(x, y, 6)) continue;
    pts.push({ x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, j: r() });
  }
  return pts;
}

export interface Network {
  neurons: Point[];
  adj: number[][];
  edges: [number, number][];
}

export function network(points: Point[], max = 84): Network {
  const neurons: Point[] = [];
  for (const p of points) {
    if (neurons.length >= max) break;
    if (Math.hypot(p.x - CORE.x, p.y - CORE.y) < 46) continue;
    if (neurons.every((n) => Math.hypot(n.x - p.x, n.y - p.y) > 50)) neurons.push(p);
  }
  const adj: number[][] = neurons.map(() => []);
  const edges: [number, number][] = [];
  const seen = new Set<string>();
  neurons.forEach((n, i) => {
    neurons
      .map((m, k) => ({ k, d: Math.hypot(m.x - n.x, m.y - n.y) }))
      .filter((o) => o.k !== i && o.d < 120)
      .sort((a, b) => a.d - b.d)
      .slice(0, 3)
      .forEach(({ k }) => {
        const id = i < k ? `${i}-${k}` : `${k}-${i}`;
        if (seen.has(id)) return;
        seen.add(id);
        adj[i].push(k);
        adj[k].push(i);
        edges.push([i, k]);
      });
  });
  return { neurons, adj, edges };
}

/**
 * Hands out positions inside a region on a sunflower spiral around its anchor,
 * skipping anything outside the brain, on the knowledge box or crowding the
 * agent at the centre — so any number of items fits without stacking.
 */
export function placer() {
  const counters: Record<Region, number> = { projects: 0, people: 0, rules: 0, routines: 0 };
  const taken: { x: number; y: number }[] = [];
  return (region: Region): { x: number; y: number } => {
    const a = REGIONS[region];
    for (let guard = 0; guard < 400; guard++) {
      const i = counters[region]++;
      const angle = i * 2.39996;
      const r = 38 * Math.sqrt(i + 0.35);
      const x = Math.round(a.x + Math.cos(angle) * r * 1.35);
      const y = Math.round(a.y + Math.sin(angle) * r * 0.9);
      if (!inBrain(x, y) || inKnowledgeBox(x, y, 14)) continue;
      if (Math.hypot(x - CORE.x, y - CORE.y) < 70) continue;
      if (taken.some((t) => Math.hypot(t.x - x, t.y - y) < 32)) continue;
      taken.push({ x, y });
      return { x, y };
    }
    return { x: a.x, y: a.y };
  };
}

// Where an untagged memory most likely belongs, from the words in it. Only a
// default for the map: a region a person chose always wins, and the page says
// which memories were filed this way.
const REGION_WORDS: Record<Region, RegExp> = {
  people: /\b(people|person|founders?|owners?|team|speakers?|ceo|cto|cfo|sponsors?|stakeholders?|who|names?|labels?)\b/g,
  rules: /\b(cannot|can't|never|must|only|rules?|policy|always|allowed|forbidden|don't|read-only|write-only|budget|limits?|scoped?)\b/g,
  routines: /\b(how|process|weekly|daily|deploy|checks?|reviews?|appl(?:y|ied)|schedules?|cadence|routines?|workflows?|steps?|runs?)\b/g,
  projects: /\b(projects?|boards?|milestones?|tasks?|scope|phases?|clients?|engagements?|deliver(?:y|ables?)?|plans?)\b/g,
};

export function inferRegion(key: string, content: string): Region {
  const keyText = key.replace(/[-_]+/g, " ").toLowerCase();
  const body = content.toLowerCase();
  let best: Region = "projects";
  let bestScore = 0;
  for (const region of ["people", "rules", "routines", "projects"] as Region[]) {
    const re = REGION_WORDS[region];
    const score = (keyText.match(re)?.length ?? 0) * 3 + (body.match(re)?.length ?? 0);
    if (score > bestScore) {
      best = region;
      bestScore = score;
    }
  }
  return best;
}

export interface LabelRequest {
  id: string;
  x: number;
  y: number;
  text: string;
  /** Lower draws first and so claims the best spot. */
  priority: number;
}

export interface PlacedLabel {
  x: number;
  y: number;
  anchor: "start" | "middle" | "end";
}

interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

const CHAR_W = 7.3; // 12px monospace
const overlaps = (a: Box, b: Box) => a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;

/**
 * Gives each label the first of right / left / above / below that collides with
 * no other label, node, the knowledge box or the agent's own label. A label
 * with nowhere to go is left out — its point stays tappable, and selecting it
 * gives it the first claim on the space.
 */
export function layoutLabels(requests: LabelRequest[], nodes: { x: number; y: number }[]): Map<string, PlacedLabel> {
  const taken: Box[] = [
    { x1: KNOWLEDGE_BOX.x - 4, y1: KNOWLEDGE_BOX.y - 4, x2: KNOWLEDGE_BOX.x + KNOWLEDGE_BOX.w + 4, y2: KNOWLEDGE_BOX.y + KNOWLEDGE_BOX.h + 4 },
    { x1: CORE.x - 60, y1: CORE.y - 14, x2: CORE.x + 60, y2: CORE.y + 40 },
    ...nodes.map((n) => ({ x1: n.x - 8, y1: n.y - 8, x2: n.x + 8, y2: n.y + 8 })),
    ...Object.values(REGIONS).map((g) => {
      const w = g.label.length * 10.5;
      const x1 = g.anchor === "start" ? g.lx : g.lx - w;
      return { x1: x1 - 4, y1: g.ly - 14, x2: x1 + w + 4, y2: g.ly + 4 };
    }),
  ];
  const placed = new Map<string, PlacedLabel>();
  for (const r of [...requests].sort((a, b) => a.priority - b.priority)) {
    const w = r.text.length * CHAR_W;
    const options: (PlacedLabel & { box: Box })[] = [
      { x: r.x + 14, y: r.y + 4, anchor: "start", box: { x1: r.x + 12, y1: r.y - 9, x2: r.x + 16 + w, y2: r.y + 7 } },
      { x: r.x - 14, y: r.y + 4, anchor: "end", box: { x1: r.x - 16 - w, y1: r.y - 9, x2: r.x - 12, y2: r.y + 7 } },
      { x: r.x, y: r.y - 13, anchor: "middle", box: { x1: r.x - w / 2 - 2, y1: r.y - 26, x2: r.x + w / 2 + 2, y2: r.y - 9 } },
      { x: r.x, y: r.y + 23, anchor: "middle", box: { x1: r.x - w / 2 - 2, y1: r.y + 10, x2: r.x + w / 2 + 2, y2: r.y + 27 } },
    ];
    // Facing away from the agent reads better, so try that side first.
    if (r.x < CORE.x) options.splice(0, 2, options[1], options[0]);
    const fit = options.find(
      (o) => o.box.x1 > 44 && o.box.x2 < 976 && !taken.some((t) => overlaps(t, o.box) && !(t.x1 === r.x - 8 && t.y1 === r.y - 8)),
    );
    if (!fit) continue;
    taken.push(fit.box);
    placed.set(r.id, { x: fit.x, y: fit.y, anchor: fit.anchor });
  }
  return placed;
}

export const CYCLE_S = 7;
const HOP_S = 0.49;

export interface Firing {
  x: number;
  y: number;
  color: string;
}

export interface Signal {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  delay: string;
}

export interface Spike {
  x: number;
  y: number;
  s: number;
  hs: number;
  burst: boolean;
  color: string;
  delay: string;
}

/**
 * One cascade per firing item: it starts at the item, hops neuron to neuron
 * toward the agent and ends there. Starts are spread evenly over the cycle so
 * the brain fires steadily instead of all at once.
 */
export function cascades(net: Network, firing: Firing[]): { signals: Signal[]; spikes: Spike[] } {
  const { neurons, adj } = net;
  const signals: Signal[] = [];
  const spikes: Spike[] = [];
  if (!neurons.length) return { signals, spikes };
  const t = (v: number) => `${(((v % CYCLE_S) + CYCLE_S) % CYCLE_S).toFixed(2)}s`;
  const distToCore = (i: number) => Math.hypot(neurons[i].x - CORE.x, neurons[i].y - CORE.y);
  const nearest = (x: number, y: number) => {
    let best = 0;
    let bd = Infinity;
    neurons.forEach((n, i) => {
      const d = Math.hypot(n.x - x, n.y - y);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  };

  firing.forEach((f, fi) => {
    const path: { x: number; y: number }[] = [{ x: f.x, y: f.y }];
    let cur = nearest(f.x, f.y);
    const seen = new Set<number>();
    for (let step = 0; step < 7; step++) {
      seen.add(cur);
      path.push(neurons[cur]);
      if (distToCore(cur) < 95) break;
      const next = adj[cur].filter((k) => !seen.has(k)).sort((a, b) => distToCore(a) - distToCore(b))[0];
      if (next === undefined) break;
      cur = next;
    }
    path.push(CORE);
    const offset = (fi * CYCLE_S) / Math.max(firing.length, 1);
    path.forEach((p, k) => {
      if (k > 0 && k === path.length - 1) return;
      const s = k === 0 ? 6 : 4.5;
      spikes.push({ x: p.x, y: p.y, s, hs: s * 4, burst: k === 0, color: f.color, delay: t(offset + k * HOP_S) });
      const q = path[k + 1];
      signals.push({ x1: p.x, y1: p.y, x2: q.x, y2: q.y, color: f.color, delay: t(offset + k * HOP_S) });
    });
  });
  return { signals, spikes };
}
