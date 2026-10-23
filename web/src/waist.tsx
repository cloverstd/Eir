import { useRef, useState } from "react";
import { api } from "./api";
import type { Row } from "./api";
import { DateField } from "./components/DatePicker";
import { SelectField } from "./components/forms";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Label } from "./components/ui/label";
import { Textarea } from "./components/ui/textarea";
import { Alert, AlertDescription } from "./components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./components/ui/dialog";

export function WaistRecordDialog({
  members,
  member,
  busy,
  action,
  onClose,
}: {
  members: Row[];
  member: string;
  busy: boolean;
  action: (fn: () => Promise<unknown>, message?: string) => Promise<void>;
  onClose: () => void;
}) {
  const submitting = useRef(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [measuredAt] = useState(() =>
    new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 16),
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !submitting.current) onClose();
      }}
    >
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
        showCloseButton={!saving}
      >
        <DialogHeader>
          <DialogTitle>记录腰围</DialogTitle>
          <DialogDescription>
            单位为 cm，可补录历史测量。每次保存为一条独立记录。
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            if (submitting.current || busy) return;
            const fields = new FormData(event.currentTarget);
            const selected = String(fields.get("member_id") || "");
            if (!members.some((m) => m.id === selected)) {
              setError("请选择家庭成员");
              return;
            }
            submitting.current = true;
            setSaving(true);
            setError("");
            try {
              await action(async () => {
                try {
                  await api(`members/${selected}/observations`, "POST", {
                    kind: "waist",
                    unit: "cm",
                    value: Number(fields.get("value")),
                    measured_at: new Date(
                      `${fields.get("measured_at")}:00+08:00`,
                    ).toISOString(),
                    notes: String(fields.get("notes") || ""),
                  });
                  onClose();
                } catch (cause) {
                  setError(cause instanceof Error ? cause.message : String(cause));
                  throw cause;
                }
              }, "腰围已保存");
            } finally {
              submitting.current = false;
              setSaving(false);
            }
          }}
        >
          <fieldset disabled={busy || saving} className="grid min-w-0 gap-4">
            <Label className="grid gap-2">
              家庭成员
              <SelectField
                name="member_id"
                required
                defaultValue={members.some((m) => m.id === member) ? member : ""}
              >
                <option value="" disabled>请选择成员</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </SelectField>
            </Label>
            <Label className="grid gap-2">
              腰围（cm）
              <Input
                name="value"
                type="number"
                inputMode="decimal"
                step="any"
                min={10}
                max={400}
                required
              />
            </Label>
            <Label className="grid gap-2">
              测量时间（上海时间）
              <DateField
                name="measured_at"
                type="datetime-local"
                required
                defaultValue={measuredAt}
              />
            </Label>
            <Label className="grid gap-2">
              备注（可选）
              <Textarea name="notes" maxLength={4000} rows={2} />
            </Label>
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={onClose}>取消</Button>
              <Button type="submit">{saving ? "正在保存…" : "保存腰围"}</Button>
            </div>
          </fieldset>
        </form>
      </DialogContent>
    </Dialog>
  );
}
