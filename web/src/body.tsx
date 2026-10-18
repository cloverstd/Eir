import { useState } from "react";
import type { Row } from "./api";
import { SelectField } from "./components/forms";
import { Input } from "./components/ui/input";
import { Label } from "./components/ui/label";
export function ProfileFields({ member }: { member?: Row }) {
  const [month, setMonth] = useState(
      member?.birth_month || member?.birth_date?.slice(0, 7) || "",
    ),
    [day, setDay] = useState(member?.birth_date?.slice(0, 10) || "");
  return (
    <>
      <Label className="grid gap-2">
        计算用性别
        <SelectField name="sex" defaultValue={member?.sex || ""}>
          <option value="">暂不填写</option>
          <option value="male">男</option>
          <option value="female">女</option>
        </SelectField>
      </Label>
      <Label className="grid gap-2">
        出生年月
        <Input
          type="month"
          name="birth_month"
          value={month}
          onChange={(e) => {
            setMonth(e.target.value);
            if (day && !day.startsWith(e.target.value)) setDay("");
          }}
        />
      </Label>
      <Label className="grid gap-2">
        出生日期（可选）
        <Input
          type="date"
          name="birth_date"
          value={day}
          onChange={(e) => {
            setDay(e.target.value);
            if (e.target.value) setMonth(e.target.value.slice(0, 7));
          }}
        />
      </Label>
      <Label className="grid gap-2">
        身高（厘米）
        <Input
          type="number"
          min="50"
          max="250"
          step="0.1"
          name="height_cm"
          defaultValue={member?.height_cm || ""}
          placeholder="体脂估算需要"
        />
      </Label>
    </>
  );
}
