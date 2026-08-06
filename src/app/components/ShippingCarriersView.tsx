import { useEffect, useMemo, useState } from "react";
import {
  normalizeShippingCarrierSettings,
  ShippingCarrierSetting,
  uid,
  useStore,
} from "../store";
import { confirmWrite } from "../utils/writeConfirm";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Switch } from "./ui/switch";
import { Plus, Save, Trash2, Truck } from "lucide-react";
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
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(copyCarriers(savedCarriers));
  }, [savedCarriers]);

  const changed = JSON.stringify(draft) !== JSON.stringify(savedCarriers);
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
    if (!confirmWrite("修改", "保存快递公司配置。")) return;
    setSaving(true);
    const ok = await saveStateTransform((latest) => ({
      ...latest,
      systemSettings: {
        ...latest.systemSettings,
        shippingCarriers: normalized,
      },
    }));
    setSaving(false);
    if (!ok) return toast.error("快递公司配置保存失败，请重试");
    setDraft(copyCarriers(normalized));
    toast.success("快递公司配置已保存");
  };

  if (state.user?.role !== "admin") {
    return <div className="p-6 text-sm text-muted-foreground">当前账户无权访问快递公司管理。</div>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto p-4 sm:p-6">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Truck className="size-5 text-sky-700" />
              <h1 className="text-xl font-semibold">快递公司管理</h1>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">共 {draft.length} 家，已启用 {enabledCount} 家</p>
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
