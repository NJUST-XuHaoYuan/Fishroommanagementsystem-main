import { useEffect, useMemo, useState } from "react";
import {
  configuredOrderPackagingFee,
  normalizeShippingCarrierSettings,
  ShippingCarrierSetting,
  uid,
  useStore,
} from "../store";
import { confirmWrite } from "../utils/writeConfirm";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Switch } from "./ui/switch";
import { Package, Plus, Save, Trash2, Truck } from "lucide-react";
import { toast } from "sonner";

function copyCarriers(carriers: ShippingCarrierSetting[]): ShippingCarrierSetting[] {
  return carriers.map((carrier) => ({ ...carrier }));
}

export function ShippingCarriersView() {
  const { state, saveStateTransform } = useStore();
  const savedCarriers = useMemo(
    () => normalizeShippingCarrierSettings(state.systemSettings),
    [state.systemSettings]
  );
  const [draft, setDraft] = useState<ShippingCarrierSetting[]>(() => copyCarriers(savedCarriers));
  const savedPackagingFee = configuredOrderPackagingFee(state.systemSettings);
  const [packagingFee, setPackagingFee] = useState(savedPackagingFee);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(copyCarriers(savedCarriers));
    setPackagingFee(savedPackagingFee);
  }, [savedCarriers, savedPackagingFee]);

  const changed = JSON.stringify(draft) !== JSON.stringify(savedCarriers) || packagingFee !== savedPackagingFee;
  const enabledCount = draft.filter((carrier) => carrier.enabled).length;

  const updateCarrier = (id: string, patch: Partial<ShippingCarrierSetting>) => {
    setDraft((current) => current.map((carrier) =>
      carrier.id === id ? { ...carrier, ...patch } : carrier
    ));
  };

  const addCarrier = () => {
    if (draft.length >= 100) return toast.error("快递公司最多配置 100 项");
    setDraft((current) => [...current, {
      id: `carrier-${uid()}`,
      name: "",
      enabled: true,
    }]);
  };

  const removeCarrier = (id: string) => {
    setDraft((current) => current.filter((carrier) => carrier.id !== id));
  };

  const save = async () => {
    if (state.user?.role !== "admin" || saving) return;
    const normalized = draft.map((carrier) => ({
      ...carrier,
      name: carrier.name.trim(),
    }));
    if (normalized.some((carrier) => !carrier.name)) return toast.error("请填写快递公司名称");
    const duplicate = normalized.find((carrier, index) =>
      normalized.findIndex((candidate) => candidate.name.toLowerCase() === carrier.name.toLowerCase()) !== index
    );
    if (duplicate) return toast.error(`快递公司名称不能重复：${duplicate.name}`);
    if (!normalized.some((carrier) => carrier.enabled)) return toast.error("请至少启用一家快递公司");
    if (!Number.isFinite(packagingFee) || packagingFee < 0) return toast.error("请填写有效的统一包装费");
    if (!confirmWrite("修改", "保存订单包装费和快递公司配置。")) return;
    setSaving(true);
    const ok = await saveStateTransform((latest) => ({
      ...latest,
      systemSettings: {
        ...latest.systemSettings,
        orderPackagingFee: Number(packagingFee.toFixed(2)),
        shippingCarriers: normalized,
      },
    }));
    setSaving(false);
    if (!ok) return toast.error("订单与物流配置保存失败，请重试");
    setDraft(copyCarriers(normalized));
    toast.success("订单与物流配置已保存");
  };

  if (state.user?.role !== "admin") {
    return <div className="p-6 text-sm text-muted-foreground">当前账户无权访问订单与物流设置。</div>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto p-4 sm:p-6">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Truck className="size-5 text-sky-700" />
              <h1 className="text-xl font-semibold">订单与物流设置</h1>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">统一订单包装费，并维护发货时可选择的快递公司</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={addCarrier} disabled={saving}>
              <Plus className="size-4" />
              新增
            </Button>
            <Button onClick={() => void save()} disabled={!changed || saving}>
              <Save className="size-4" />
              {saving ? "保存中..." : "保存配置"}
            </Button>
          </div>
        </div>

        <section className="rounded-md border bg-card p-4">
          <div className="flex items-start gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-muted/40">
              <Package className="size-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-semibold">统一包装费</div>
              <p className="mt-1 text-sm text-muted-foreground">新建订单自动使用该金额，订单内不能单独修改；历史订单保留创建时的金额。</p>
              <div className="mt-3 flex max-w-xs items-center gap-2">
                <span className="text-sm text-muted-foreground">¥</span>
                <Input
                  type="number"
                  min={0}
                  step={0.01}
                  value={Number.isFinite(packagingFee) ? packagingFee : ""}
                  onChange={(event) => setPackagingFee(Number(event.target.value))}
                  aria-label="统一包装费"
                />
                <span className="shrink-0 text-sm text-muted-foreground">元 / 单</span>
              </div>
            </div>
          </div>
        </section>

        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold">快递公司</h2>
            <p className="mt-1 text-sm text-muted-foreground">共 {draft.length} 家，已启用 {enabledCount} 家</p>
          </div>
        </div>

        <div className="hidden overflow-hidden rounded-md border bg-card sm:block">
          <table className="w-full table-fixed text-sm">
            <thead className="bg-muted/50 text-left text-foreground">
              <tr>
                <th className="px-4 py-3 font-semibold">快递公司</th>
                <th className="w-28 px-4 py-3 text-center font-semibold">状态</th>
                <th className="w-20 px-4 py-3 text-center font-semibold">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {draft.map((carrier) => (
                <tr key={carrier.id}>
                  <td className="px-4 py-3">
                    <Input
                      value={carrier.name}
                      onChange={(event) => updateCarrier(carrier.id, { name: event.target.value })}
                      placeholder="快递公司名称"
                    />
                  </td>
                  <td className="px-4 py-3 text-center">
                    <Switch
                      checked={carrier.enabled}
                      onCheckedChange={(enabled) => updateCarrier(carrier.id, { enabled })}
                      aria-label={`${carrier.name || "未命名快递公司"}启用状态`}
                    />
                  </td>
                  <td className="px-4 py-3 text-center">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => removeCarrier(carrier.id)}
                      title="删除"
                      aria-label={`删除${carrier.name || "未命名快递公司"}`}
                    >
                      <Trash2 className="size-4 text-red-600" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="grid gap-3 sm:hidden">
          {draft.map((carrier) => (
            <div key={carrier.id} className="rounded-md border bg-card p-3">
              <div className="flex items-center gap-2">
                <Input
                  value={carrier.name}
                  onChange={(event) => updateCarrier(carrier.id, { name: event.target.value })}
                  placeholder="快递公司名称"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => removeCarrier(carrier.id)}
                  title="删除"
                  aria-label={`删除${carrier.name || "未命名快递公司"}`}
                >
                  <Trash2 className="size-4 text-red-600" />
                </Button>
              </div>
              <div className="mt-3 flex items-center justify-between text-sm">
                <span className="text-muted-foreground">启用</span>
                <Switch
                  checked={carrier.enabled}
                  onCheckedChange={(enabled) => updateCarrier(carrier.id, { enabled })}
                  aria-label={`${carrier.name || "未命名快递公司"}启用状态`}
                />
              </div>
            </div>
          ))}
        </div>

        {draft.length === 0 && (
          <div className="rounded-md border border-dashed py-10 text-center text-sm text-muted-foreground">
            暂无快递公司
          </div>
        )}
      </div>
    </div>
  );
}
