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
import { fmtUsd } from "@/lib/roi";

// Recharts wrappers themed entirely through CSS variables, so charts re-theme
// with light/dark automatically (SVG accepts var(--token) for fill/stroke).
// Formatting is passed as a string kind (not a function) because these are Client
// Components and functions can't cross the server→client boundary as props.

const AXIS = "var(--muted)";

export type ValueFormat = "usd" | "number";

function formatValue(n: number, format?: ValueFormat): string {
  return format === "usd" ? fmtUsd(n) : n.toLocaleString();
}

function GlassTooltip({
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
    <div className="glass-strong rounded-xl px-3 py-2 text-xs">
      {label != null && <div className="mb-0.5 text-[var(--muted)]">{label}</div>}
      <div className="font-semibold text-[var(--text)]">{formatValue(v, format)}</div>
    </div>
  );
}

/** Hero area trend with a gradient fill. */
export function AreaTrend({
  points,
  color = "var(--brand)",
  height = 240,
  format,
  gradientId = "area-grad",
}: {
  points: { label: string; value: number }[];
  color?: string;
  height?: number;
  format?: ValueFormat;
  gradientId?: string;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.5} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
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
          content={<GlassTooltip format={format} />}
        />
        <Area
          type="monotone"
          dataKey="value"
          stroke={color}
          strokeWidth={2.5}
          fill={`url(#${gradientId})`}
          dot={false}
          activeDot={{ r: 4, fill: color, stroke: "var(--surface-solid)", strokeWidth: 2 }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/** Tiny inline sparkline for KPI cards. */
export function Sparkline({
  points,
  color = "var(--brand-2)",
  height = 44,
  id = "spark",
}: {
  points: number[];
  color?: string;
  height?: number;
  id?: string;
}) {
  const data = points.map((v, i) => ({ i, value: v }));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.45} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <Area
          type="monotone"
          dataKey="value"
          stroke={color}
          strokeWidth={2}
          fill={`url(#${id})`}
          dot={false}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/** Horizontal bars, e.g. net value by skill. */
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
        <defs>
          <linearGradient id="bar-grad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="var(--brand)" />
            <stop offset="100%" stopColor="var(--brand-2)" />
          </linearGradient>
        </defs>
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
          cursor={{ fill: "var(--surface)" }}
          content={<GlassTooltip format={format} />}
        />
        <Bar dataKey="value" fill="url(#bar-grad)" radius={[6, 6, 6, 6]} maxBarSize={22}>
          {data.map((_, i) => (
            <Cell key={i} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Single-value radial gauge (0–100%). */
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
          <defs>
            <linearGradient id="gauge-grad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="var(--brand)" />
              <stop offset="100%" stopColor="var(--brand-2)" />
            </linearGradient>
          </defs>
          <PolarAngleAxis type="number" domain={[0, 100]} tick={false} />
          <RadialBar
            dataKey="value"
            cornerRadius={999}
            fill="url(#gauge-grad)"
            background={{ fill: "var(--surface-strong)" }}
          />
        </RadialBarChart>
      </ResponsiveContainer>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        {center && <div className="text-2xl font-semibold text-[var(--text)]">{center}</div>}
        {label && <div className="mt-0.5 text-xs text-[var(--muted)]">{label}</div>}
      </div>
    </div>
  );
}
