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
const colors = ["#2563eb", "#94a3b8", "#b45309", "#6d28d9"];
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
}: Props) {
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
          ? s.data.filter(([time]) => time >= range.from && time <= range.to)
          : s.data,
      }))
      .filter(({ s, data }) => s.axis !== "right" || data.some(([, value]) => value !== null));
    const rightSeriesIds = new Set(
      plottedSeries.filter(({ s }) => s.axis === "right").map(({ s }) => s.id),
    );
    const showRightAxis = Boolean(rightAxis && rightSeriesIds.size);
    const extremaSeries = (): LineSeriesOption => {
      let min = Infinity;
      let max = -Infinity;
      for (const { name, data } of series) {
        if (legendSelection.current[name] === false) continue;
        for (const [stamp, value] of data) {
          if (
            stamp < bounds.from || stamp > bounds.to ||
            value === null || !Number.isFinite(value)
          ) continue;
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
          data: min === Infinity
            ? []
            : [
                {
                  yAxis: max,
                  name: `最高 ${max} ${unit}`,
                  lineStyle: { color: "#dc2626" },
                  label: { position: "insideEndTop" },
                },
                {
                  yAxis: min,
                  name: `最低 ${min} ${unit}`,
                  lineStyle: { color: "#2563eb", dashOffset: 6 },
                  label: { position: "insideStartTop" },
                },
              ],
        },
      };
    };
    chart.setOption(
      {
        animation: false,
        color: colors,
        textStyle: {
          fontFamily: 'system-ui, "PingFang SC", sans-serif',
          fontSize: 11,
        },
        grid: { left: 54, right: showRightAxis ? 54 : 24, top: 24, bottom: 60 },
        legend: {
          type: "scroll",
          bottom: 0,
          itemWidth: 14,
          itemHeight: 7,
          textStyle: { color: "#737373" },
        },
        tooltip: {
          trigger: "axis",
          confine: true,
          appendToBody: false,
          formatter: (params: any) => {
            const values = Array.isArray(params) ? params : [params];
            const stamp = values[0]?.value?.[0];
            return (
              `<strong>${escape(memberName || label)}</strong><br/>${escape(stamp ? time(stamp) : "")}<br/>` +
              values
                .map((p: any) => {
                  const seriesUnit = rightAxis && rightSeriesIds.has(p.seriesId) ? rightAxis.unit : unit;
                  return `${p.marker}${escape(p.seriesName)}：${p.value?.[1] == null ? "—" : escape(p.value[1])} ${escape(seriesUnit)}`;
                })
                .join("<br/>")
            );
          },
        },
        xAxis: {
          type: "time",
          min: bounds.from,
          max: bounds.to,
          splitNumber: 3,
          axisLine: { lineStyle: { color: "#d4d4d4" } },
          axisLabel: {
            hideOverlap: true,
            color: "#737373",
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
            position: "left",
            scale: true,
            axisLabel: {
              color: "#737373",
              formatter: (value: number) =>
                value.toLocaleString("zh-CN", { maximumFractionDigits: 1 }),
            },
            splitLine: { lineStyle: { color: "#f0f0f0" } },
            min: referenceValues.length
              ? (value: { min: number }) =>
                  Math.floor(Math.min(value.min, ...referenceValues) - 1)
              : undefined,
            max: referenceValues.length
              ? (value: { max: number }) =>
                  Math.ceil(Math.max(value.max, ...referenceValues) + 1)
              : undefined,
          },
          ...(rightAxis ? [{
            id: "secondary",
            type: "value",
            name: rightAxis.name,
            position: "right",
            show: showRightAxis,
            scale: true,
            minInterval: 0.01,
            axisLabel: {
              color: "#737373",
              formatter: (value: number) =>
                value.toLocaleString("zh-CN", { maximumFractionDigits: 2 }),
            },
            splitLine: { show: false },
          }] : []),
        ],
        series: plottedSeries.map<LineSeriesOption>(({ s, data }, index) => ({
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
          itemStyle: { color: s.color || colors[index % colors.length] },
          lineStyle: {
            width: 2,
            type: s.lineType || "solid",
            cap: "round",
            join: "round",
          },
          ...(index === 0 && reference?.band
            ? {
                markArea: {
                  silent: true,
                  itemStyle: { color: "rgba(34,197,94,.07)" },
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
                  lineStyle: { type: "dashed" as const, color: "#a3a3a3" },
                  label: {
                    position: "insideEndTop" as const,
                    fontSize: 10,
                    formatter: (p: any) => p.name,
                  },
                  data: reference.lines.map((line) => ({
                    yAxis: line.value,
                    name: line.label,
                  })),
                },
              }
            : {}),
        })).concat(showExtrema ? [extremaSeries()] : []),
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
    range?.from,
    range?.to,
    domain?.from,
    domain?.to,
  ]);
  return (
    <div
      ref={ref}
      className="h-72 w-full min-w-0 sm:h-80"
      role="img"
      aria-label={label}
    />
  );
}
