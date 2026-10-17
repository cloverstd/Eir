export function canManageCollector(c: Record<string, any>): boolean {
  return !!c.online && (!c.lifecycle_state || c.lifecycle_state === "bound") && (c.supports_lifecycle === true || Number(c.protocol_version || c.status?.protocol_version) >= 2);
}
export function previewBlocked(p: Record<string, any> | null, now = Date.now()): boolean {
  return !p?.preview_token || !!p.blockers?.length || (!!p.expires_at && new Date(p.expires_at).getTime() <= now);
}
export function operationLabel(value: string): string {
  const labels: Record<string,string> = { claim:"添加采集端", binding:"绑定中", unbinding:"解绑中", committing:"正在提交", awaiting_provisioning:"等待重新配网", pending:"等待执行", preparing:"准备中", running:"执行中", executing:"执行中", completed:"已完成", succeeded:"已完成", failed:"失败", waiting_reprovision:"等待重新配网", waiting_network:"等待重新配网", bound:"已绑定", unbound:"未绑定", pending_baseline:"待启用", baseline_pending:"待建立基线", active:"采集中", disabled:"已停用", collector_reset:"重置采集端", factory_reset:"恢复出厂", system_reset:"重置系统", collector_unbind:"解绑采集端", device_bind:"绑定测量设备", device_unbind:"解绑测量设备", collector_bind:"绑定采集端", collector_delete:"删除采集端" };
  return labels[value] || value || "等待同步";
}
