import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./components/ui/dialog";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Label } from "./components/ui/label";
import { Card } from "./components/ui/card";
import { Badge } from "./components/ui/badge";
import { SelectField, Disclosure } from "./components/forms";
import { useState } from "react";
import {
  canManageCollector,
  operationLabel,
  previewBlocked,
} from "./lifecycleDomain";
type Row = Record<string, any>;
type API = (path: string, method?: string, body?: unknown) => Promise<any>;
type Action = (fn: () => Promise<unknown>, message?: string) => Promise<void>;
type Props = {
  api: API;
  action: Action;
  busy: boolean;
};
const key = encodeURIComponent;
export function Operations({ operations }: { operations: Row[] }) {
  const running = operations.filter(
    (o) =>
      !["succeeded", "completed", "failed", "expired", "cancelled"].includes(
        o.state || o.status,
      ),
  ).length;
  return (
    <Disclosure open={running > 0}>
      <summary>
        设备操作进度 ·{" "}
        {running ? `${running} 项进行中` : `${operations.length} 项`}
      </summary>
      <p className="text-sm leading-6 text-muted-foreground">
        操作记录会在刷新页面后保留，并随设备回复更新。提交成功不代表设备已完成清理。
      </p>
      {!operations.length ? (
        <p className="text-sm leading-6 text-muted-foreground">暂无操作</p>
      ) : (
        operations.map((o) => (
          <Disclosure
            key={o.id || o.operation_id}
            open={
              ![
                "succeeded",
                "completed",
                "failed",
                "expired",
                "cancelled",
              ].includes(o.state || o.status)
            }
            className="min-w-0"
          >
            <summary>
              <strong>{operationLabel(o.type || o.kind)}</strong> ·{" "}
              {operationLabel(o.state || o.status)}{" "}
              <small className="block text-xs leading-5 text-muted-foreground">
                {o.collector_id || o.device_id || "系统"}
              </small>
            </summary>
            <p className="text-sm leading-6 text-muted-foreground">
              {o.message ||
                o.error ||
                (["succeeded", "completed"].includes(o.status || o.state)
                  ? "操作已完成"
                  : "等待设备与服务同步执行结果")}
            </p>
            <code className="break-all text-xs text-muted-foreground">
              {o.id || o.operation_id}
            </code>
            {o.result && (
              <pre className="max-h-96 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-3 text-xs">
                {JSON.stringify(o.result, null, 2)}
              </pre>
            )}
          </Disclosure>
        ))
      )}
    </Disclosure>
  );
}
export function Discovered({
  rows,
  api,
  action,
  busy,
}: Props & {
  rows: Row[];
}) {
  return (
    <Disclosure open={rows.length > 0}>
      <summary>待添加的采集端 · {rows.length}</summary>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="min-w-0 break-words text-base font-semibold tracking-tight">
            待添加的 ESP32
          </h2>
          <Badge className="text-xs">{rows.length} 台</Badge>
        </div>
        <p className="text-sm leading-6 text-muted-foreground">
          新刷机的采集端先在自身配网页设置 Wi-Fi 和 MQTT。联网后在此核对设备
          ID，再手动绑定到 Eir；未绑定不会开始采集。
        </p>
        {!rows.length ? (
          <p className="text-sm leading-6 text-muted-foreground">
            暂无待添加设备
          </p>
        ) : (
          <div className="grid min-w-0 gap-4 xl:grid-cols-2">
            {rows.map((c) => (
              <div
                className="min-w-0 space-y-3 rounded-lg border p-4"
                key={c.id}
              >
                <h3 className="text-sm font-semibold">{c.name || c.id}</h3>
                <code className="break-all text-xs text-muted-foreground">
                  {c.id}
                </code>
                <p className="text-sm leading-6 text-muted-foreground">
                  {c.status?.ip || "IP 未知"} · 固件{" "}
                  {c.status?.firmware_version || c.status?.firmware || "—"} ·{" "}
                  {c.online ? "在线" : "离线"}
                </p>
                {c.deleted && (
                  <p className="text-sm leading-6 text-muted-foreground">
                    已从 Eir 删除。重新绑定后需重新添加测量设备。
                  </p>
                )}
                <form
                  className="grid min-w-0 items-end gap-4 sm:grid-cols-2 [&>button]:justify-self-start"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const data = Object.fromEntries(
                      new FormData(e.currentTarget),
                    );
                    action(
                      () =>
                        api(`collectors/${key(c.id)}/bind`, "POST", {
                          ...data,
                          enrollment_nonce: c.enrollment_nonce,
                        }),
                      "绑定请求已提交，请等待设备确认后添加测量设备",
                    );
                  }}
                >
                  <Label className="grid min-w-0 gap-2 text-sm">
                    名称
                    <Input
                      name="name"
                      required
                      defaultValue={c.name || ""}
                      placeholder="客厅采集端"
                    />
                  </Label>
                  <Label className="grid min-w-0 gap-2 text-sm">
                    位置
                    <Input name="location" placeholder="例如 客厅" />
                  </Label>
                  <Button disabled={busy || !c.online || !c.enrollment_nonce}>
                    添加绑定
                  </Button>
                </form>
                {!c.enrollment_nonce && (
                  <p className="text-sm leading-6 text-muted-foreground">
                    等待新固件发出入网请求；旧固件请先升级。
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </Disclosure>
  );
}
export function ConfirmAction({
  label,
  description,
  run,
  busy,
  disabled = false,
  action,
  message = "操作已提交，请查看执行进度",
}: {
  label: string;
  description: string;
  run: () => Promise<unknown>;
  busy: boolean;
  disabled?: boolean;
  action: Action;
  message?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="min-w-0">
      <Button
        disabled={busy || disabled}
        onClick={() => setOpen(!open)}
        variant="outline"
      >
        {label}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{label}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap items-start gap-2">
            <Button
              disabled={busy || disabled}
              onClick={() =>
                action(async () => {
                  await run();
                  setOpen(false);
                }, message)
              }
            >
              确认{label}
            </Button>
            <Button
              disabled={busy}
              onClick={() => setOpen(false)}
              variant="outline"
            >
              取消
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
export function ResetAction({
  type,
  collector,
  scope,
  label,
  api,
  action,
  busy,
}: Props & {
  type: string;
  collector?: Row;
  scope?: string;
  label: string;
}) {
  const [preview, setPreview] = useState<Row | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const blocked = previewBlocked(preview);
  return (
    <div className="min-w-0">
      <Button
        disabled={busy || (!!collector && !canManageCollector(collector))}
        onClick={() =>
          action(async () => {
            setPreview(null);
            setConfirmation("");
            setPreview(
              await api("operations/preview", "POST", {
                type,
                collector_id: collector?.id,
                scope,
              }),
            );
          }, "请核对重置影响范围")
        }
        variant="outline"
      >
        {label}
      </Button>
      <Dialog
        open={!!preview}
        onOpenChange={(open) => {
          if (!open) setPreview(null);
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{label} · 影响预览</DialogTitle>
            <DialogDescription>
              核对影响范围后输入 RESET 确认。
            </DialogDescription>
          </DialogHeader>
          {preview && (
            <>
              <dl className="grid grid-cols-[auto_1fr] [&>div]:contents gap-x-4 gap-y-2 text-sm">
                {Object.entries(preview.counts || {}).map(([k, v]) => (
                  <div key={k}>
                    <dt className="text-muted-foreground">
                      {(
                        {
                          measurements: "测量记录",
                          members: "家庭成员",
                          devices: "测量设备",
                          collectors: "采集端",
                          pending: "待上传记录",
                          queue_depth: "待上传记录",
                          queued_records: "待上传记录",
                          bindings: "用户绑定",
                          health_history: "健康经历",
                          documents: "医疗文件",
                          manual_observations: "手动指标",
                        } as Row
                      )[k] || k}
                    </dt>
                    <dd className="min-w-0 break-words">{String(v)}</dd>
                  </div>
                ))}
              </dl>
              {preview.devices && (
                <pre className="max-h-96 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-3 text-xs">
                  {JSON.stringify(preview.devices, null, 2)}
                </pre>
              )}
              {preview.blockers?.length > 0 && (
                <div role="alert">
                  <strong>当前无法执行</strong>
                  <ul>
                    {preview.blockers.map((b: any, i: number) => (
                      <li key={i}>
                        {typeof b === "string"
                          ? b
                          : b.message || b.reason || JSON.stringify(b)}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <p className="text-sm leading-6 text-muted-foreground">
                {type === "factory_reset"
                  ? "清除采集和网络配置，设备将进入配网热点，需要重新设置 Wi-Fi/MQTT。"
                  : type === "collector_reset"
                    ? "清除采集绑定、缓存和进度，保留网络与固件，设备回到待添加状态。"
                    : scope === "all"
                      ? "清空成员、健康数据、健康经历、医疗文件和设备关联。保留服务设置及固件库；离线 ESP32 的本地数据不会被远程擦除。"
                      : "清空设备测量和手动指标，保留成员档案、健康经历、医疗文件和设备绑定。需设备在线并成功读取血压计建立基线后执行。"}
              </p>
              <p className="text-sm leading-6 text-muted-foreground">
                不清除血压计自身记录、已有备份和导出文件。重置后只采集新记录。
              </p>
              <Label className="grid min-w-0 gap-2 text-sm">
                输入 RESET 确认
                <Input
                  autoComplete="off"
                  value={confirmation}
                  onChange={(e) => setConfirmation(e.target.value)}
                />
              </Label>
              <div className="flex flex-wrap items-start gap-2">
                <Button
                  disabled={busy || blocked || confirmation !== "RESET"}
                  onClick={() =>
                    action(async () => {
                      const body = {
                        preview_token: preview.preview_token,
                        confirmation,
                        ...(collector
                          ? {
                              mode:
                                type === "factory_reset"
                                  ? "factory"
                                  : "runtime",
                            }
                          : { scope }),
                      };
                      await api(
                        collector
                          ? `collectors/${key(collector.id)}/reset`
                          : "system/reset",
                        "POST",
                        body,
                      );
                      setPreview(null);
                      setConfirmation("");
                    }, "重置已提交，请查看操作进度")
                  }
                >
                  确认执行{label}
                </Button>
                <Button
                  disabled={busy}
                  onClick={() => setPreview(null)}
                  variant="outline"
                >
                  取消
                </Button>
              </div>
              {preview.expires_at && (
                <p className="text-sm leading-6 text-muted-foreground">
                  预览有效期至{" "}
                  {new Date(preview.expires_at).toLocaleString("zh-CN", {
                    timeZone: "Asia/Shanghai",
                  })}
                </p>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
export function CollectorActions({
  collector: c,
  ...props
}: Props & {
  collector: Row;
}) {
  return (
    <div className="space-y-3 border-t pt-4">
      <div className="flex flex-wrap items-start gap-2">
        <ConfirmAction
          {...props}
          label="解绑采集端"
          disabled={!canManageCollector(c)}
          description="先补传待确认记录，再清理采集关联和蓝牙绑定。保留网络及 Eir 健康历史，设备回到待添加状态。"
          run={() => props.api(`collectors/${key(c.id)}/unbind`, "POST", {})}
        />
        <ConfirmAction
          {...props}
          label="从 Eir 删除"
          message="已从 Eir 删除；设备本地清理未确认，健康历史已保留"
          description="立即解除设备分配并从 Eir 删除，不等待设备回复。保留健康历史；此操作不保证设备本地已清理。重新绑定须手动添加。"
          run={() => props.api(`collectors/${key(c.id)}`, "DELETE")}
        />
      </div>
      <div className="flex flex-wrap items-start gap-2">
        <ResetAction
          {...props}
          collector={c}
          type="collector_reset"
          label="重置采集端"
        />
        <ResetAction
          {...props}
          collector={c}
          type="factory_reset"
          label="恢复出厂"
        />
      </div>
      {!canManageCollector(c) && (
        <p className="text-sm leading-6 text-muted-foreground">
          远程解绑和重置需要采集端在线且固件支持设备管理；离线仍可直接删除。
        </p>
      )}
    </div>
  );
}
export function DeviceActions({
  device: d,
  collectors,
  ...props
}: Props & {
  device: Row;
  collectors: Row[];
}) {
  const c = collectors.find((c) => c.id === d.collector_id);
  const [target, setTarget] = useState("");
  return (
    <div className="space-y-3 border-t pt-4">
      <p className="text-sm leading-6 text-muted-foreground">
        状态：
        {operationLabel(
          d.lifecycle_state || (d.collector_id ? "bound" : "unbound"),
        )}
        。
        {d.profile === "afu-wl-tz-a1"
          ? "唤醒体脂秤验证通知后启用。"
          : "新绑定需唤醒血压计建立基线，启用后只采集新增记录。"}
      </p>
      {d.collector_id ? (
        <ConfirmAction
          {...props}
          disabled={!c || !canManageCollector(c)}
          label={d.profile === "afu-wl-tz-a1" ? "解绑体脂秤" : "解绑血压计"}
          description="停止此设备采集并补传待确认记录，清理对应本地关联。保留健康历史，不影响此采集端的其他设备。"
          run={() => props.api(`devices/${key(d.id)}/unbind`, "POST", {})}
        />
      ) : (
        <form
          className="grid min-w-0 items-end gap-4 sm:grid-cols-2 [&>button]:justify-self-start"
          onSubmit={(e) => {
            e.preventDefault();
            props.action(
              () =>
                props.api(`devices/${key(d.id)}/bind`, "POST", {
                  collector_id: target,
                }),
              "绑定已提交，请唤醒测量设备并查看执行进度",
            );
          }}
        >
          <Label className="grid min-w-0 gap-2 text-sm">
            绑定到采集端
            <SelectField
              required
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            >
              <option value="">请选择</option>
              {collectors.filter(canManageCollector).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name || c.id}
                </option>
              ))}
            </SelectField>
          </Label>
          <Button disabled={props.busy || !target}>绑定采集端</Button>
        </form>
      )}
    </div>
  );
}
