import type { Schedule } from "@ai-hub/db";

// Wording shared by the Overview and the agents pages, so a sum of money or a
// "3h ago" reads the same everywhere it appears.

export const money = (n: number) => (n === 0 ? "$0" : n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`);

/** "Just now", "12m ago", "3h ago", "5d ago", then a date. */
export function rel(iso: string | null, now: number, never = "Never"): string {
  if (!iso) return never;
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 60) return "Just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 14) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

export const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Every 2 hours", "Mon, Wed at 07:30". */
export function cadence(s: Pick<Schedule, "kind" | "intervalMinutes" | "atMinute" | "weekdays">): string {
  if (s.kind === "every") {
    const m = s.intervalMinutes ?? 0;
    if (m && m % 1440 === 0) return m === 1440 ? "Every day" : `Every ${m / 1440} days`;
    if (m && m % 60 === 0) return m === 60 ? "Every hour" : `Every ${m / 60} hours`;
    return `Every ${m} minutes`;
  }
  const at = s.atMinute ?? 0;
  const time = `${String(Math.floor(at / 60)).padStart(2, "0")}:${String(at % 60).padStart(2, "0")}`;
  const days = s.weekdays.length === 0 || s.weekdays.length === 7 ? "Every day" : s.weekdays.map((d) => DAYS[d]).join(", ");
  return `${days} at ${time}`;
}
