import { useEffect, useRef } from "react";
import * as echarts from "echarts/core";
import { LineChart } from "echarts/charts";
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
};

export function TimeSeriesChart({
  series,
  unit,
  label,
  memberName,
  reference,
  range,
  domain,
}: Props) {
  const ref = useRef<HTMLDivElement>(null),
    chartRef = useRef<echarts.ECharts | null>(null);
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
    chart.setOption(
      {
        animation: false,
        color: colors,
        textStyle: {
          fontFamily: 'system-ui, "PingFang SC", sans-serif',
          fontSize: 11,
        },
        grid: { left: 54, right: 24, top: 24, bottom: 60 },
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
                .map(
                  (p: any) =>
                    `${p.marker}${escape(p.seriesName)}：${p.value?.[1] == null ? "—" : escape(p.value[1])} ${escape(unit)}`,
                )
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
        yAxis: {
          type: "value",
          name: unit,
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
        series: series.map((s, index) => ({
          id: s.id,
          name: s.name,
          type: "line",
          data: range
            ? s.data.filter(([time]) => time >= range.from && time <= range.to)
            : s.data,
          showSymbol: s.data.length < 80,
          symbolSize: 6,
          connectNulls: false,
          smooth: false,
          itemStyle: { color: s.color || colors[index % colors.length] },
          lineStyle: { width: 2, type: s.lineType || "solid" },
          ...(index === 0 && reference?.band
            ? {
                markArea: {
                  silent: true,
                  itemStyle: { color: "rgba(34,197,94,.07)" },
                  data: [
                    [
                      { yAxis: reference.band[0] },
                      { yAxis: reference.band[1] },
                    ],
                  ],
                },
              }
            : {}),
          ...(index === 0 && reference?.lines
            ? {
                markLine: {
                  silent: true,
                  symbol: "none",
                  lineStyle: { type: "dashed", color: "#a3a3a3" },
                  label: {
                    position: "insideEndTop",
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
        })),
      },
      { replaceMerge: ["series"], silent: true },
    );
  }, [
    series,
    unit,
    label,
    memberName,
    reference,
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
