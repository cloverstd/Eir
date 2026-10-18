import {
  Children,
  Fragment,
  isValidElement,
  useEffect,
  useRef,
  useState,
} from "react";
import type {
  ChangeEvent,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from "react";
import { ChevronDown, Inbox } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Checkbox } from "./ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/collapsible";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";

function options(
  children: ReactNode,
): { value: string; label: ReactNode; disabled?: boolean }[] {
  return Children.toArray(children).flatMap((child) => {
    if (
      !isValidElement<{
        children?: ReactNode;
        value?: string | number;
        disabled?: boolean;
      }>(child)
    )
      return [];
    if (child.type === Fragment) return options(child.props.children);
    return [
      {
        value: String(
          child.props.value ?? Children.toArray(child.props.children).join(""),
        ),
        label: child.props.children,
        disabled: child.props.disabled,
      },
    ];
  });
}

// Preserve the existing forms' native field names and onChange contract while
// rendering the actual shadcn Select. Empty options are also selectable.
export function SelectField({
  children,
  value,
  defaultValue,
  onChange,
  name,
  required,
  disabled,
  className,
  id,
  "aria-label": ariaLabel,
}: SelectHTMLAttributes<HTMLSelectElement>) {
  const choices = options(children),
    empty = choices.find((c) => c.value === "");
  const [local, setLocal] = useState(String(defaultValue ?? ""));
  const trigger = useRef<HTMLButtonElement>(null);
  const current = value !== undefined ? String(value) : local;
  useEffect(() => {
    const form = trigger.current?.closest("form");
    const reset = () => setLocal(String(defaultValue ?? ""));
    form?.addEventListener("reset", reset);
    return () => form?.removeEventListener("reset", reset);
  }, [defaultValue]);
  return (
    <Select
      name={name}
      required={required}
      disabled={disabled}
      value={current}
      onValueChange={(next) => {
        const actual = next === "__eir_empty__" ? "" : next;
        setLocal(actual);
        onChange?.({
          target: { value: actual },
          currentTarget: { value: actual },
        } as ChangeEvent<HTMLSelectElement>);
      }}
    >
      <SelectTrigger
        ref={trigger}
        id={id}
        aria-label={ariaLabel}
        className={cn("w-full min-w-0 bg-background", className)}
      >
        <SelectValue placeholder={empty?.label || "请选择"} />
      </SelectTrigger>
      <SelectContent>
        {choices.map((choice) => (
          <SelectItem
            key={choice.value || "__eir_empty__"}
            value={choice.value || "__eir_empty__"}
            disabled={choice.disabled}
          >
            {choice.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
export function CheckboxField({
  onChange,
  checked,
  defaultChecked,
  type: _type,
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <Checkbox
      {...(props as any)}
      className={className}
      checked={checked}
      defaultChecked={defaultChecked}
      onCheckedChange={(next) =>
        onChange?.({
          target: { checked: next === true },
          currentTarget: { checked: next === true },
        } as ChangeEvent<HTMLInputElement>)
      }
    />
  );
}
export function Disclosure({
  children,
  className,
  open,
  ...props
}: {
  children?: ReactNode;
  className?: string;
  open?: boolean;
  [key: string]: any;
}) {
  const [expanded, setExpanded] = useState(!!open);
  const interacted = useRef(false);
  useEffect(() => {
    if (open && !interacted.current) setExpanded(true);
  }, [open]);
  const items = Children.toArray(children);
  const summary = items.find(
    (child) => isValidElement(child) && child.type === "summary",
  );
  const content = items.filter((child) => child !== summary);
  const title = isValidElement<{ children?: ReactNode }>(summary)
    ? summary.props.children
    : "查看详情";
  return (
    <Collapsible
      open={expanded}
      onOpenChange={(next) => {
        interacted.current = true;
        setExpanded(next);
      }}
      className={cn("min-w-0 rounded-lg border bg-card", className)}
      {...props}
    >
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          className="group h-auto w-full justify-between gap-4 rounded-lg px-4 py-3 text-left whitespace-normal"
        >
          <span className="min-w-0 break-words">{title}</span>
          <ChevronDown className="size-4 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-4 border-t px-4 py-4">
        {content}
      </CollapsibleContent>
    </Collapsible>
  );
}
export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-32 flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
      <Inbox className="size-6 opacity-50" />
      <div>{children}</div>
    </div>
  );
}
