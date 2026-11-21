import type { Metric } from "../chartDomain";

export type MetricVisual = {
  iconBg: string;
  iconText: string;
  accentText: string;
  chartColor: string;
  badgeBg: string;
  borderAccent: string;
};

export const metricTheme: Record<Metric, MetricVisual> = {
  blood_pressure: {
    iconBg: "bg-rose-50",
    iconText: "text-rose-500",
    accentText: "text-rose-600",
    chartColor: "#f43f5e",
    badgeBg: "bg-rose-50 text-rose-700 border-rose-200/70",
    borderAccent: "border-l-rose-400",
  },
  pulse: {
    iconBg: "bg-orange-50",
    iconText: "text-orange-500",
    accentText: "text-orange-600",
    chartColor: "#f97316",
    badgeBg: "bg-orange-50 text-orange-700 border-orange-200/70",
    borderAccent: "border-l-orange-400",
  },
  weight: {
    iconBg: "bg-blue-50",
    iconText: "text-blue-600",
    accentText: "text-blue-600",
    chartColor: "#2563eb",
    badgeBg: "bg-blue-50 text-blue-700 border-blue-200/70",
    borderAccent: "border-l-blue-500",
  },
  body_fat: {
    iconBg: "bg-teal-50",
    iconText: "text-teal-600",
    accentText: "text-teal-600",
    chartColor: "#0d9488",
    badgeBg: "bg-teal-50 text-teal-700 border-teal-200/70",
    borderAccent: "border-l-teal-500",
  },
  waist: {
    iconBg: "bg-violet-50",
    iconText: "text-violet-600",
    accentText: "text-violet-600",
    chartColor: "#7c3aed",
    badgeBg: "bg-violet-50 text-violet-700 border-violet-200/70",
    borderAccent: "border-l-violet-500",
  },
};

const avatarPalettes = [
  "bg-blue-100 text-blue-700 ring-blue-200/70",
  "bg-rose-100 text-rose-700 ring-rose-200/70",
  "bg-teal-100 text-teal-700 ring-teal-200/70",
  "bg-violet-100 text-violet-700 ring-violet-200/70",
  "bg-amber-100 text-amber-700 ring-amber-200/70",
  "bg-cyan-100 text-cyan-700 ring-cyan-200/70",
  "bg-emerald-100 text-emerald-700 ring-emerald-200/70",
  "bg-indigo-100 text-indigo-700 ring-indigo-200/70",
];

export function memberAvatarStyle(seed: string | number) {
  if (typeof seed === "number") {
    return avatarPalettes[Math.abs(seed) % avatarPalettes.length];
  }
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return avatarPalettes[Math.abs(hash) % avatarPalettes.length];
}

export function memberInitial(name?: string) {
  const trimmed = (name || "").trim();
  return trimmed ? trimmed.slice(0, 1).toUpperCase() : "家";
}
