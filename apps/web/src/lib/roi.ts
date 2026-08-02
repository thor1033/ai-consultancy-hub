import type { RoiSummary, RoiTotals, SkillRoi } from "@ai-hub/db";

// Turning saved minutes into money needs one business input: the loaded hourly
// cost of the expert whose time the Skill replaces. It's a per-client number
// (a senior investment analyst is not a junior), so it's configurable via
// ANALYST_HOURLY_RATE and defaults to a conservative $120/hr.
export function analystHourlyRate(): number {
  const raw = Number(process.env.ANALYST_HOURLY_RATE);
  return Number.isFinite(raw) && raw > 0 ? raw : 120;
}

export interface ValuedRoi {
  hoursSaved: number;
  laborValueUsd: number; // saved hours priced at the analyst rate
  aiSpendUsd: number;
  netValueUsd: number; // laborValue − aiSpend
  runs: number;
  succeededRuns: number;
}

function value(totals: RoiTotals, rate: number): ValuedRoi {
  const hoursSaved = totals.minutesSaved / 60;
  const laborValueUsd = hoursSaved * rate;
  return {
    hoursSaved,
    laborValueUsd,
    aiSpendUsd: totals.costUsd,
    netValueUsd: laborValueUsd - totals.costUsd,
    runs: totals.runs,
    succeededRuns: totals.succeededRuns,
  };
}

export interface ValuedSkillRoi extends SkillRoi {
  hoursSaved: number;
  netValueUsd: number;
}

// Prices a raw ROI summary at the analyst rate: overall value + per-skill value.
export function valueRoi(summary: RoiSummary, rate = analystHourlyRate()) {
  return {
    rate,
    overall: value(summary.totals, rate),
    bySkill: summary.bySkill.map<ValuedSkillRoi>((s) => ({
      ...s,
      hoursSaved: s.minutesSaved / 60,
      netValueUsd: (s.minutesSaved / 60) * rate - s.costUsd,
    })),
  };
}

export function fmtUsd(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1000) return `$${Math.round(n).toLocaleString()}`;
  if (abs < 0.01 && n !== 0) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export function fmtHours(h: number): string {
  if (h === 0) return "0 h";
  if (h < 1) return `${Math.round(h * 60)} min`;
  return `${h.toFixed(h < 10 ? 1 : 0)} h`;
}
