"use client";

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  Cell,
  PolarAngleAxis,
  RadialBar,
  RadialBarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

// Recharts wrappers themed entirely through CSS variables, so charts re-theme
// with light/dark automatically (SVG accepts var(--token) for fill/stroke).
// Flat fills only: the design system allows no gradients outside the blue AI
// layer, and no rounded geometry. Black carries the data, red the conclusion,
// blue what the agent did.
// Formatting is passed as a string kind (not a function) because these are Client
// Components and functions can't cross the server→client boundary as props.

const AXIS = "var(--muted)";

export type ValueFormat = "usd" | "number";

function formatValue(n: number, format?: ValueFormat): string {
  return format === "usd"
    ? n.toLocaleString("en-US", { style: "currency", currency: "USD" })
    : n.toLocaleString();
}

function ChartTooltip({
  active,
  payload,
  label,
  format,
}: {
  active?: boolean;
  payload?: { value?: number | string; name?: string }[];
  label?: string | number;
  format?: ValueFormat;
}) {
  if (!active || !payload?.length) return null;
  const v = Number(payload[0]?.value ?? 0);
  return (
    <div className="panel px-3 py-2 text-xs" style={{ boxShadow: "var(--shadow-popover)" }}>
      {label != null && <div className="mb-0.5 text-[var(--muted)]">{label}</div>}
      <div className="font-semibold text-[var(--text)]">{formatValue(v, format)}</div>
    </div>
  );
}

/** Area trend with a flat tinted fill. */
export function AreaTrend({
  points,
  color = "var(--text)",
  height = 240,
  format,
}: {
  points: { label: string; value: number }[];
  color?: string;
  height?: number;
  format?: ValueFormat;
  /** Kept for callers that still pass it; fills are flat now, so it is unused. */
  gradientId?: string;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <XAxis
          dataKey="label"
          tick={{ fill: AXIS, fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          minTickGap={28}
        />
        <YAxis hide />
        <Tooltip
          cursor={{ stroke: "var(--border-strong)", strokeDasharray: 4 }}
          content={<ChartTooltip format={format} />}
        />
        <Area
          type="linear"
          dataKey="value"
          stroke={color}
          strokeWidth={2}
          fill={color}
          fillOpacity={0.1}
          dot={false}
          activeDot={{ r: 3, fill: "var(--brand)", stroke: "var(--panel)", strokeWidth: 2 }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/** Tiny inline sparkline for KPI cards. Blue: it is the agent's trace. */
export function Sparkline({
  points,
  color = "var(--ai)",
  height = 44,
}: {
  points: number[];
  color?: string;
  height?: number;
  /** Kept for callers that still pass it; unused now that fills are flat. */
  id?: string;
}) {
  const data = points.map((v, i) => ({ i, value: v }));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
        <Area
          type="linear"
          dataKey="value"
          stroke={color}
          strokeWidth={1.5}
          fill={color}
          fillOpacity={0.12}
          dot={false}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/** Horizontal bars, e.g. net value by skill. Square, black. */
export function SkillBars({
  data,
  format,
  height = 240,
}: {
  data: { name: string; value: number }[];
  format?: ValueFormat;
  height?: number;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart
        data={data}
        layout="vertical"
        margin={{ top: 4, right: 12, bottom: 4, left: 8 }}
        barCategoryGap={12}
      >
        <XAxis type="number" hide />
        <YAxis
          type="category"
          dataKey="name"
          width={128}
          tick={{ fill: "var(--text-soft)", fontSize: 12 }}
          tickLine={false}
          axisLine={false}
        />
        <Tooltip
          cursor={{ fill: "var(--panel-inset)" }}
          content={<ChartTooltip format={format} />}
        />
        <Bar dataKey="value" fill="var(--text)" radius={0} maxBarSize={22}>
          {data.map((_, i) => (
            <Cell key={i} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Single-value radial gauge (0–100%). Red: the conclusion. */
export function RatioGauge({
  percent,
  label,
  center,
  height = 200,
}: {
  percent: number; // 0..100
  label?: string;
  center?: string;
  height?: number;
}) {
  const data = [{ name: label ?? "", value: Math.max(0, Math.min(100, percent)) }];
  return (
    <div className="relative" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <RadialBarChart
          data={data}
          innerRadius="72%"
          outerRadius="100%"
          startAngle={90}
          endAngle={-270}
        >
          <PolarAngleAxis type="number" domain={[0, 100]} tick={false} />
          <RadialBar
            dataKey="value"
            cornerRadius={0}
            fill="var(--brand)"
            background={{ fill: "var(--panel-inset)" }}
          />
        </RadialBarChart>
      </ResponsiveContainer>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        {center && <div className="metric text-2xl font-bold text-[var(--text)]">{center}</div>}
        {label && <div className="mt-0.5 text-xs text-[var(--muted)]">{label}</div>}
      </div>
    </div>
  );
}
