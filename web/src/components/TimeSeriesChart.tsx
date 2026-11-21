import { useEffect, useRef } from "react";
import * as echarts from "echarts/core";
import { LineChart } from "echarts/charts";
import type { LineSeriesOption } from "echarts/charts";
import {
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  TooltipComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { useIsMobile } from "../hooks/use-mobile";
import type { ChartSeries, Reference, TimeRange } from "../chartDomain";

echarts.use([
  LineChart,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  MarkAreaComponent,
  MarkLineComponent,
  CanvasRenderer,
]);
const defaultColors = ["#2563eb", "#f43f5e", "#0d9488", "#7c3aed", "#f97316"];
const time = (value: number) =>
  new Date(value).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false,
  });
const escape = (value: unknown) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );

function hexToRgba(hex: string, alpha: number) {
  const m = hex.match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
  if (!m) return `rgba(37, 99, 235, ${alpha})`;
  return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${alpha})`;
}

type Props = {
  series: ChartSeries[];
  unit: string;
  label: string;
  memberName?: string;
  reference?: Reference;
  range?: TimeRange;
  domain?: TimeRange;
  showExtrema?: boolean;
  rightAxis?: { name: string; unit: string };
  accentColor?: string;
};

export function TimeSeriesChart({
  series,
  unit,
  label,
  memberName,
  reference,
  range,
  domain,
  showExtrema,
  rightAxis,
  accentColor,
}: Props) {
  const mobile = useIsMobile();
  const ref = useRef<HTMLDivElement>(null),
    chartRef = useRef<echarts.ECharts | null>(null);
  const legendSelection = useRef<Record<string, boolean>>({});
  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current);
    chartRef.current = chart;
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(ref.current);
    return () => {
      observer.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const palette = accentColor
      ? [accentColor, "#64748b", ...defaultColors.filter((c) => c !== accentColor)]
      : defaultColors;
    const times = series.flatMap((s) => s.data.map((p) => p[0]));
    const first = times.length
      ? times.reduce((a, b) => Math.min(a, b), Infinity)
      : Date.now() - 86400000;
    const last = times.length
      ? times.reduce((a, b) => Math.max(a, b), -Infinity)
      : Date.now();
    const referenceValues =
      reference?.band || reference?.lines?.map((line) => line.value) || [];
    const bounds = range ||
      domain || {
        from: first,
        to: last === first ? last + 60000 : last,
      };
    const plottedSeries = series
      .map((s) => ({
        s,
        data: range
          ? s.data.filter(([stamp]) => stamp >= range.from && stamp <= range.to)
          : s.data,
      }))
      .filter(
        ({ s, data }) =>
          s.axis !== "right" || data.some(([, value]) => value !== null),
      );
    const rightSeriesIds = new Set(
      plottedSeries.filter(({ s }) => s.axis === "right").map(({ s }) => s.id),
    );
    const showRightAxis = Boolean(rightAxis && rightSeriesIds.size);
    const singleSeriesFill = plottedSeries.length === 1;
    const extremaSeries = (): LineSeriesOption => {
      let min = Infinity;
      let max = -Infinity;
      for (const { name, data } of series) {
        if (legendSelection.current[name] === false) continue;
        for (const [stamp, value] of data) {
          if (
            stamp < bounds.from ||
            stamp > bounds.to ||
            value === null ||
            !Number.isFinite(value)
          )
            continue;
          min = Math.min(min, value);
          max = Math.max(max, value);
        }
      }
      // Keep the chart-wide markers independent of the individual legend entries.
      return {
        id: "extrema-markers",
        type: "line",
        data: [],
        silent: true,
        markLine: {
          silent: true,
          symbol: "none",
          precision: -1,
          lineStyle: { type: [5, 7], width: 1.5 },
          label: { fontSize: 10, formatter: ({ name }) => name },
          data:
            min === Infinity
              ? []
              : [
                  {
                    yAxis: max,
                    name: `最高 ${max} ${unit}`,
                    lineStyle: { color: "#e11d48" },
                    label: { position: "insideEndTop", color: "#e11d48" },
                  },
                  {
                    yAxis: min,
                    name: `最低 ${min} ${unit}`,
                    lineStyle: { color: "#2563eb", dashOffset: 6 },
                    label: { position: "insideStartTop", color: "#2563eb" },
                  },
                ],
        },
      };
    };
    chart.setOption(
      {
        animation: false,
        color: palette,
        textStyle: {
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", system-ui, sans-serif',
          fontSize: 11,
        },
        grid: {
          left: mobile ? 42 : 52,
          right: showRightAxis ? (mobile ? 42 : 52) : mobile ? 14 : 22,
          top: 26,
          bottom: 58,
        },
        legend: {
          type: "scroll",
          bottom: 0,
          itemWidth: 14,
          itemHeight: 7,
          icon: "roundRect",
          textStyle: { color: "#64748b", fontSize: 11 },
        },
        tooltip: {
          trigger: "axis",
          confine: true,
          appendToBody: false,
          backgroundColor: "rgba(255, 255, 255, 0.96)",
          borderColor: "#e2e8f0",
          borderWidth: 1,
          padding: [10, 12],
          textStyle: { color: "#0f172a", fontSize: 12 },
          extraCssText:
            "border-radius: 12px; box-shadow: 0 8px 24px rgba(15, 23, 42, 0.08);",
          axisPointer: {
            lineStyle: { color: "#cbd5e1", type: "dashed" },
          },
          formatter: (params: any) => {
            const values = Array.isArray(params) ? params : [params];
            const stamp = values[0]?.value?.[0];
            return (
              `<div style="font-weight:600;margin-bottom:2px;color:#0f172a">${escape(memberName || label)}</div>` +
              `<div style="font-size:11px;color:#64748b;margin-bottom:6px">${escape(stamp ? time(stamp) : "")}</div>` +
              values
                .map((p: any) => {
                  const seriesUnit =
                    rightAxis && rightSeriesIds.has(p.seriesId)
                      ? rightAxis.unit
                      : unit;
                  return `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;line-height:1.6"><span>${p.marker}${escape(p.seriesName)}</span><strong style="font-variant-numeric:tabular-nums">${p.value?.[1] == null ? "—" : escape(p.value[1])} ${escape(seriesUnit)}</strong></div>`;
                })
                .join("")
            );
          },
        },
        xAxis: {
          type: "time",
          min: bounds.from,
          max: bounds.to,
          splitNumber: mobile ? 3 : 4,
          axisLine: { lineStyle: { color: "#e2e8f0" } },
          axisTick: { show: false },
          axisLabel: {
            hideOverlap: true,
            color: "#64748b",
            margin: 10,
            formatter: (value: number) =>
              new Date(value).toLocaleDateString("zh-CN", {
                timeZone: "Asia/Shanghai",
                month: "numeric",
                day: "numeric",
              }) +
              "\n" +
              new Date(value).toLocaleTimeString("zh-CN", {
                timeZone: "Asia/Shanghai",
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
              }),
          },
        },
        yAxis: [
          {
            id: "primary",
            type: "value",
            name: unit,
            nameTextStyle: { color: "#94a3b8", padding: [0, 0, 0, -8] },
            position: "left",
            scale: true,
            axisLabel: {
              color: "#64748b",
              formatter: (value: number) =>
                value.toLocaleString("zh-CN", { maximumFractionDigits: 1 }),
            },
            splitLine: { lineStyle: { color: "#eef2f6", type: "dashed" } },
            min: referenceValues.length
              ? (value: { min: number }) =>
                  Math.floor(Math.min(value.min, ...referenceValues) - 1)
              : undefined,
            max: referenceValues.length
              ? (value: { max: number }) =>
                  Math.ceil(Math.max(value.max, ...referenceValues) + 1)
              : undefined,
          },
          ...(rightAxis
            ? [
                {
                  id: "secondary",
                  type: "value",
                  name: rightAxis.name,
                  nameTextStyle: { color: "#94a3b8" },
                  position: "right" as const,
                  show: showRightAxis,
                  scale: true,
                  minInterval: 0.01,
                  axisLabel: {
                    color: "#64748b",
                    formatter: (value: number) =>
                      value.toLocaleString("zh-CN", {
                        maximumFractionDigits: 2,
                      }),
                  },
                  splitLine: { show: false },
                },
              ]
            : []),
        ],
        series: plottedSeries
          .map<LineSeriesOption>(({ s, data }, index) => {
            const lineColor = s.color || palette[index % palette.length];
            return {
              id: s.id,
              name: s.name,
              type: "line",
              yAxisIndex: rightAxis && s.axis === "right" ? 1 : 0,
              data,
              showSymbol: s.data.length < 80,
              symbolSize: 6,
              connectNulls: false,
              smooth: 0.35,
              smoothMonotone: "x",
              itemStyle: { color: lineColor },
              lineStyle: {
                width: 2.25,
                type: s.lineType || "solid",
                cap: "round",
                join: "round",
              },
              ...(singleSeriesFill
                ? {
                    areaStyle: {
                      color: {
                        type: "linear" as const,
                        x: 0,
                        y: 0,
                        x2: 0,
                        y2: 1,
                        colorStops: [
                          { offset: 0, color: hexToRgba(lineColor, 0.14) },
                          { offset: 1, color: hexToRgba(lineColor, 0.01) },
                        ],
                      },
                    },
                  }
                : {}),
              ...(index === 0 && reference?.band
                ? {
                    markArea: {
                      silent: true,
                      itemStyle: { color: "rgba(16, 185, 129, 0.08)" },
                      data: [
                        [
                          { yAxis: reference.band[0] },
                          { yAxis: reference.band[1] },
                        ] as [{ yAxis: number }, { yAxis: number }],
                      ],
                    },
                  }
                : {}),
              ...(index === 0 && reference?.lines
                ? {
                    markLine: {
                      silent: true,
                      symbol: "none",
                      lineStyle: { type: "dashed" as const, color: "#94a3b8" },
                      label: {
                        position: "insideEndTop" as const,
                        fontSize: 10,
                        color: "#64748b",
                        formatter: (p: any) => p.name,
                      },
                      data: reference.lines.map((line) => ({
                        yAxis: line.value,
                        name: line.label,
                      })),
                    },
                  }
                : {}),
            };
          })
          .concat(showExtrema ? [extremaSeries()] : []),
      },
      { replaceMerge: ["series", "yAxis"], silent: true },
    );
    if (!showExtrema) return;
    const onLegendChange = (event: unknown) => {
      const { selected } = event as { selected: Record<string, boolean> };
      legendSelection.current = { ...legendSelection.current, ...selected };
      chart.setOption({ series: [extremaSeries()] }, { silent: true });
    };
    chart.on("legendselectchanged", onLegendChange);
    return () => {
      chart.off("legendselectchanged", onLegendChange);
    };
  }, [
    series,
    unit,
    label,
    memberName,
    reference,
    showExtrema,
    rightAxis,
    accentColor,
    mobile,
    range?.from,
    range?.to,
    domain?.from,
    domain?.to,
  ]);
  return (
    <div
      ref={ref}
      className="h-68 w-full min-w-0 sm:h-80"
      role="img"
      aria-label={label}
    />
  );
}
