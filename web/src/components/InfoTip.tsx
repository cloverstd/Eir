import { useState, type ReactNode } from "react";
import { Info } from "lucide-react";
import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

export function InfoTip({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 text-muted-foreground"
          aria-label={label}
          onClick={(event) => {
            event.preventDefault();
            setOpen(!open);
          }}
        >
          <Info className="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent sideOffset={6} className="max-w-72 space-y-1 leading-5">
        {children}
      </TooltipContent>
    </Tooltip>
  );
}
