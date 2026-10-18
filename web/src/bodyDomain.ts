export const scaleProfile = "afu-wl-tz-a1";
export function scaleNumber(device: Record<string, any>): string {
  return device.profile === scaleProfile && device.scale_number != null
    ? `S${String(device.scale_number).padStart(3, "0")}`
    : "";
}
export function deviceLabel(device: Record<string, any>): string {
  const code = scaleNumber(device);
  return code ? `${code} · ${device.name}` : device.name;
}
export function bodyFatValue(row: Record<string, any>): number | null {
  return row.weight_valid !== false && row.body_fat_status === "estimated"
    ? Number(row.body_fat_pct)
    : null;
}
export function bodyFatStatus(status: string): string {
  return (
    (
      {
        missing_adc: "未取得有效 ADC",
        missing_profile: "请完善成员资料",
        invalid_time: "采集端未校时",
        estimated: "估算",
      } as Record<string, string>
    )[status] || "未取得"
  );
}
export function memberProfile(values: Record<string, any>) {
  return {
    ...values,
    height_cm: values.height_cm ? Number(values.height_cm) : null,
  };
}
