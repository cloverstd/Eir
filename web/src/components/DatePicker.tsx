import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, InputHTMLAttributes } from "react";
import type { DateRange } from "react-day-picker";
import { zhCN } from "date-fns/locale";
import { CalendarDays, Clock } from "lucide-react";
import { Button } from "./ui/button";
import { Calendar } from "./ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { SelectField } from "./forms";
import { useIsMobile } from "../hooks/use-mobile";
import { cn } from "../lib/utils";
import {
  calendarDate,
  calendarValue,
  rangeBounds,
  rangePresets,
  shanghaiDay,
} from "../dateDomain";

const calendarProps = {
  locale: zhCN,
  labels: {
    labelNext: () => "下个月",
    labelPrevious: () => "上个月",
    labelNav: () => "月份导航",
    labelMonthDropdown: () => "选择月份",
    labelYearDropdown: () => "选择年份",
    labelDayButton: (day: Date) =>
      new Intl.DateTimeFormat("zh-CN", {
        year: "numeric",
        month: "long",
        day: "numeric",
        weekday: "long",
      }).format(day),
  },
  captionLayout: "dropdown" as const,
  startMonth: new Date(1900, 0),
  endMonth: new Date(2100, 11),
  formatters: {
    formatMonthDropdown: (date: Date) => `${date.getMonth() + 1}月`,
  },
};
const display = (value: string) => value.replaceAll("-", "/").replace("T", " ");
const fieldLabels: Record<string, string> = {
  birth_month: "出生年月",
  birth_date: "出生日期（可选）",
  measured_at: "测量时间（上海时间）",
  effective_from: "生效时间（上海时间）",
  occurred_on: "发生／开始日期",
  ended_on: "结束日期",
  document_date: "检查日期",
  recorded_on: "检查日期",
  examined_on: "检查日期",
};

// The submitted value remains the original date/month/Shanghai wall-time
// string. Form validity and reset still work with existing FormData handlers.
export function DateField({
  type = "date",
  name,
  value,
  defaultValue,
  onChange,
  required,
  disabled,
  min,
  max,
  className,
  id,
  placeholder,
  "aria-label": ariaLabel,
}: InputHTMLAttributes<HTMLInputElement>) {
  const controlled = value !== undefined;
  const [local, setLocal] = useState(String(defaultValue ?? ""));
  const current = String(controlled ? (value ?? "") : local);
  const [open, setOpen] = useState(false),
    [invalid, setInvalid] = useState(false);
  const [draftDay, setDraftDay] = useState<Date>(),
    [draftTime, setDraftTime] = useState("00:00"),
    [year, setYear] = useState(new Date().getFullYear());
  const trigger = useRef<HTMLButtonElement>(null);
  const label =
    ariaLabel ||
    fieldLabels[name || ""] ||
    (type === "month"
      ? "选择月份"
      : type === "datetime-local"
        ? "选择日期和时间"
        : "选择日期");
  const commit = (next: string) => {
    if (!controlled) setLocal(next);
    setInvalid(false);
    onChange?.({
      target: { value: next, name },
      currentTarget: { value: next, name },
    } as ChangeEvent<HTMLInputElement>);
    setOpen(false);
  };
  useEffect(() => {
    const form = trigger.current?.closest("form");
    const reset = () => {
      setLocal(String(defaultValue ?? ""));
      setInvalid(false);
    };
    form?.addEventListener("reset", reset);
    return () => form?.removeEventListener("reset", reset);
  }, [defaultValue]);
  const changeOpen = (next: boolean) => {
    if (next) {
      setDraftDay(calendarDate(current.slice(0, 10)));
      setDraftTime(current.split("T")[1]?.slice(0, 5) || "00:00");
      setYear(Number(current.slice(0, 4)) || Number(shanghaiDay().slice(0, 4)));
    }
    setOpen(next);
  };
  const unavailable = (day: Date) => {
    const selected = calendarValue(day);
    return !!(
      (min && selected < String(min).slice(0, 10)) ||
      (max && selected > String(max).slice(0, 10))
    );
  };
  return (
    <Popover open={open} onOpenChange={changeOpen}>
      {(name || required) && (
        <input
          type="text"
          name={name}
          value={current}
          onChange={() => {}}
          required={required}
          disabled={disabled}
          tabIndex={-1}
          aria-hidden="true"
          className="sr-only"
          onInvalid={(event) => {
            event.preventDefault();
            setInvalid(true);
            changeOpen(true);
            trigger.current?.focus();
          }}
        />
      )}
      <PopoverTrigger asChild>
        <Button
          ref={trigger}
          id={id}
          type="button"
          variant="outline"
          disabled={disabled}
          aria-label={label}
          aria-required={required}
          aria-invalid={invalid}
          className={cn(
            "w-full min-w-0 justify-start gap-2 bg-background text-left font-normal",
            !current && "text-muted-foreground",
            className,
          )}
        >
          <CalendarDays className="size-4 shrink-0" />
          <span className="truncate">
            {current
              ? display(current)
              : placeholder ||
                (type === "month"
                  ? "请选择年月"
                  : type === "datetime-local"
                    ? "请选择日期和时间"
                    : "请选择日期")}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-auto max-w-[calc(100vw-2rem)] p-0"
      >
        {type === "month" ? (
          <div className="w-72 space-y-4 p-4">
            <SelectField
              aria-label="年份"
              value={String(year)}
              onChange={(event) => setYear(Number(event.target.value))}
            >
              {Array.from({ length: 201 }, (_, index) => 1900 + index).map(
                (y) => (
                  <option key={y} value={y}>
                    {y} 年
                  </option>
                ),
              )}
            </SelectField>
            <div className="grid grid-cols-3 gap-2">
              {Array.from({ length: 12 }, (_, i) => {
                const month = `${year}-${String(i + 1).padStart(2, "0")}`;
                return (
                  <Button
                    key={month}
                    type="button"
                    variant={current === month ? "default" : "ghost"}
                    disabled={
                      !!(
                        (min && month < String(min).slice(0, 7)) ||
                        (max && month > String(max).slice(0, 7))
                      )
                    }
                    onClick={() => commit(month)}
                  >
                    {i + 1} 月
                  </Button>
                );
              })}
            </div>
          </div>
        ) : (
          <Calendar
            {...calendarProps}
            mode="single"
            required
            selected={draftDay}
            defaultMonth={draftDay || calendarDate(shanghaiDay())}
            disabled={unavailable}
            autoFocus
            onSelect={(day) => {
              setDraftDay(day);
              if (day && type !== "datetime-local") commit(calendarValue(day));
            }}
          />
        )}
        {type === "datetime-local" && (
          <div className="space-y-3 border-t p-4">
            <div className="flex items-center gap-2">
              <Clock className="size-4 text-muted-foreground" />
              <span className="mr-auto text-xs text-muted-foreground">
                上海时间
              </span>
              <SelectField
                aria-label="小时"
                className="w-20"
                value={draftTime.slice(0, 2)}
                onChange={(e) =>
                  setDraftTime(e.target.value + draftTime.slice(2))
                }
              >
                {Array.from({ length: 24 }, (_, i) =>
                  String(i).padStart(2, "0"),
                ).map((hour) => (
                  <option key={hour} value={hour}>
                    {hour}
                  </option>
                ))}
              </SelectField>
              <span>:</span>
              <SelectField
                aria-label="分钟"
                className="w-20"
                value={draftTime.slice(3, 5)}
                onChange={(e) =>
                  setDraftTime(draftTime.slice(0, 3) + e.target.value)
                }
              >
                {Array.from({ length: 60 }, (_, i) =>
                  String(i).padStart(2, "0"),
                ).map((minute) => (
                  <option key={minute} value={minute}>
                    {minute}
                  </option>
                ))}
              </SelectField>
            </div>
            <Button
              type="button"
              className="w-full"
              disabled={!draftDay}
              onClick={() => commit(calendarValue(draftDay) + "T" + draftTime)}
            >
              确定时间
            </Button>
          </div>
        )}
        <div className="flex items-center justify-between gap-3 border-t px-4 py-3">
          <span className="text-xs text-muted-foreground">
            {invalid
              ? "请选择日期后再保存"
              : type === "month"
                ? "仅记录年月"
                : "点击日期完成选择"}
          </span>
          {!required && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => commit("")}
            >
              清除
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export type RangeSelection = { period: string; from: string; to: string };
export function DateRangePicker({
  period = "all",
  from = "",
  to = "",
  onChange,
  label = "时间范围",
  className,
}: RangeSelection & {
  onChange: (value: RangeSelection) => void;
  label?: string;
  className?: string;
}) {
  const mobile = useIsMobile();
  const [open, setOpen] = useState(false),
    [draft, setDraft] = useState<DateRange>();
  const [selectingEnd, setSelectingEnd] = useState(false);
  const bounds = rangeBounds(period, from, to);
  const active =
    period === "custom"
      ? { from: calendarDate(from), to: calendarDate(to) }
      : period === "all"
        ? undefined
        : {
            from: calendarDate(shanghaiDay(Date.parse(bounds.from!))),
            to: calendarDate(shanghaiDay()),
          };
  const title =
    period === "custom"
      ? [from ? display(from) : "开始日期", to ? display(to) : "结束日期"].join(
          " — ",
        )
      : rangePresets.find((p) => p.value === period)?.label ||
        (period === "7" ? "最近 7 天" : "选择时间范围");
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setDraft(active);
          setSelectingEnd(false);
        }
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          aria-label={label}
          className={cn(
            "w-full justify-start bg-background font-normal sm:min-w-64",
            className,
          )}
        >
          <CalendarDays className="size-4 shrink-0" />
          <span className="truncate">{title}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="max-h-[calc(100dvh-2rem)] w-auto max-w-[calc(100vw-2rem)] overflow-y-auto p-0"
      >
        <div className="flex flex-col sm:flex-row">
          <div className="grid grid-cols-2 gap-1 border-b p-3 sm:flex sm:w-36 sm:shrink-0 sm:flex-col sm:border-r sm:border-b-0">
            {rangePresets.map((preset) => (
              <Button
                key={preset.value}
                type="button"
                variant={period === preset.value ? "secondary" : "ghost"}
                size="sm"
                className="justify-start"
                onClick={() => {
                  onChange({ period: preset.value, from: "", to: "" });
                  setOpen(false);
                }}
              >
                {preset.label}
              </Button>
            ))}
            <p className="col-span-2 px-2 pt-2 text-xs leading-5 text-muted-foreground">
              也可在日历中选择起止日期
            </p>
          </div>
          <div className="min-w-0">
            <Calendar
              {...calendarProps}
              mode="range"
              numberOfMonths={mobile ? 1 : 2}
              selected={draft}
              defaultMonth={active?.from || calendarDate(shanghaiDay())}
              onSelect={(_, day) => {
                if (!selectingEnd) {
                  setDraft({ from: day, to: undefined });
                  setSelectingEnd(true);
                } else {
                  const start = draft?.from || day;
                  setDraft(
                    day < start
                      ? { from: day, to: start }
                      : { from: start, to: day },
                  );
                  setSelectingEnd(false);
                }
              }}
              autoFocus
            />
            <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3">
              <span className="text-xs text-muted-foreground">
                {draft?.from ? display(calendarValue(draft.from)) : "开始日期"}{" "}
                — {draft?.to ? display(calendarValue(draft.to)) : "结束日期"}
              </span>
              <Button
                type="button"
                size="sm"
                disabled={!draft?.from || !draft.to}
                onClick={() => {
                  onChange({
                    period: "custom",
                    from: calendarValue(draft?.from),
                    to: calendarValue(draft?.to),
                  });
                  setOpen(false);
                }}
              >
                应用范围
              </Button>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// Signal history has a seven-day retention policy and fixed sampling buckets.
// Use the same picker surface for its supported time durations.
export function DurationPicker({
  value,
  onChange,
  label = "时间范围",
}: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const options = [
    { value: "15m", label: "最近 15 分钟" },
    { value: "1h", label: "最近 1 小时" },
    { value: "24h", label: "最近 24 小时" },
    { value: "7d", label: "最近 7 天" },
  ];
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          aria-label={label}
          className="w-full justify-start bg-background font-normal"
        >
          <Clock className="size-4" />
          {options.find((option) => option.value === value)?.label}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 space-y-1 p-2">
        {options.map((option) => (
          <Button
            type="button"
            key={option.value}
            variant={option.value === value ? "secondary" : "ghost"}
            className="w-full justify-start"
            onClick={() => {
              onChange(option.value);
              setOpen(false);
            }}
          >
            {option.label}
          </Button>
        ))}
        <p className="px-3 py-2 text-xs text-muted-foreground">
          信号历史保留 7 天
        </p>
      </PopoverContent>
    </Popover>
  );
}
