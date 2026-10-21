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
      const r = 34 * Math.sqrt(i + 0.35);
      const x = Math.round(a.x + Math.cos(angle) * r * 1.35);
      const y = Math.round(a.y + Math.sin(angle) * r * 0.9);
      if (!inBrain(x, y) || inKnowledgeBox(x, y, 14)) continue;
      if (Math.hypot(x - CORE.x, y - CORE.y) < 70) continue;
      if (taken.some((t) => Math.hypot(t.x - x, t.y - y) < 26)) continue;
      taken.push({ x, y });
      return { x, y };
    }
    return { x: a.x, y: a.y };
  };
}

/** Untagged memories wait in rings around the agent until someone files them. */
export function ringSlot(i: number, n: number): { x: number; y: number } {
  const perRing = 10;
  const ring = Math.floor(i / perRing);
  const inRing = Math.min(perRing, n - ring * perRing);
  const a = -Math.PI / 2 + ((i % perRing) / Math.max(inRing, 1)) * Math.PI * 2;
  const rx = 150 + ring * 46;
  const ry = 104 + ring * 32;
  return { x: Math.round(CORE.x + Math.cos(a) * rx), y: Math.round(CORE.y + Math.sin(a) * ry) };
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
