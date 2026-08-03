import { useEffect, useMemo, useState } from "react";
import {
  normalizePaymentMethodSettings,
  PAYMENT_CHANNEL_OPTIONS,
  paymentChannelLabel,
  PaymentMethodSetting,
  uid,
  useStore,
} from "../store";
import { confirmWrite } from "../utils/writeConfirm";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Switch } from "./ui/switch";
import { Plus, Save, Trash2, WalletCards } from "lucide-react";
import { toast } from "sonner";

function copyMethods(methods: PaymentMethodSetting[]): PaymentMethodSetting[] {
  return methods.map((method) => ({ ...method }));
}

export function PaymentMethodsView() {
  const { state, saveStateTransform } = useStore();
  const savedMethods = useMemo(
    () => normalizePaymentMethodSettings(state.systemSettings),
    [state.systemSettings]
  );
  const [draft, setDraft] = useState<PaymentMethodSetting[]>(() => copyMethods(savedMethods));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(copyMethods(savedMethods));
  }, [savedMethods]);

  const changed = JSON.stringify(draft) !== JSON.stringify(savedMethods);

  const updateMethod = (id: string, patch: Partial<PaymentMethodSetting>) => {
    setDraft((current) => current.map((method) =>
      method.id === id ? { ...method, ...patch } : method
    ));
  };

  const addMethod = () => {
    setDraft((current) => [...current, {
      id: `pm-${uid()}`,
      name: "",
      channel: "wechat",
      account: "",
      enabled: false,
    }]);
  };

  const removeMethod = (id: string) => {
    setDraft((current) => current.filter((method) => method.id !== id));
  };

  const save = async () => {
    if (state.user?.role !== "admin" || saving) return;
    const normalized = draft.map((method) => ({
      ...method,
      name: method.name.trim(),
      account: method.account.trim(),
    }));
    const unnamed = normalized.find((method) => !method.name);
    if (unnamed) return toast.error("请填写付款方式名称");
    const duplicateName = normalized.find((method, index) =>
      normalized.findIndex((candidate) => candidate.name.toLowerCase() === method.name.toLowerCase()) !== index
    );
    if (duplicateName) return toast.error(`付款方式名称不能重复：${duplicateName.name}`);
    const invalid = normalized.find((method) => method.enabled && !method.account);
    if (invalid) return toast.error(`请配置${paymentChannelLabel(invalid.channel)}收款账户`);
    if (!normalized.some((method) => method.enabled)) return toast.error("请至少启用一种付款方式");
    if (!confirmWrite("修改", "保存付款方式和默认收款账户配置。")) return;
    setSaving(true);
    const ok = await saveStateTransform((latest) => ({
      ...latest,
      systemSettings: {
        ...latest.systemSettings,
        paymentMethods: normalized,
      },
    }));
    setSaving(false);
    if (!ok) return toast.error("付款方式配置保存失败，请重试");
    setDraft(copyMethods(normalized));
    toast.success("付款方式配置已保存");
  };

  if (state.user?.role !== "admin") {
    return <div className="p-6 text-sm text-muted-foreground">当前账户无权访问付款方式管理。</div>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto p-4 sm:p-6">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <WalletCards className="size-5 text-sky-700" />
              <h1 className="text-xl font-semibold">付款方式管理</h1>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">可新增多个付款方式，同一资金渠道可配置不同收款账户</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={addMethod} disabled={saving}>
              <Plus className="size-4" />
              新增付款方式
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
                <th className="w-[22%] px-4 py-3 font-semibold">付款方式名称</th>
                <th className="w-[18%] px-4 py-3 font-semibold">资金渠道</th>
                <th className="px-4 py-3 font-semibold">收款账户</th>
                <th className="w-28 px-4 py-3 text-center font-semibold">状态</th>
                <th className="w-20 px-4 py-3 text-center font-semibold">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {draft.map((method) => (
                <tr key={method.id}>
                  <td className="px-4 py-3">
                    <Input
                      value={method.name}
                      onChange={(event) => updateMethod(method.id, { name: event.target.value })}
                      placeholder="例如：微信南京店"
                    />
                  </td>
                  <td className="px-4 py-3">
                    <Select
                      value={method.channel}
                      onValueChange={(channel) => updateMethod(method.id, { channel: channel as PaymentMethodSetting["channel"] })}
                    >
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {PAYMENT_CHANNEL_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </td>
                  <td className="px-4 py-3">
                    <Input
                      value={method.account}
                      onChange={(event) => updateMethod(method.id, { account: event.target.value })}
                      placeholder="账户名称或银行卡尾号"
                    />
                  </td>
                  <td className="px-4 py-3 text-center">
                    <Switch
                      checked={method.enabled}
                      onCheckedChange={(enabled) => updateMethod(method.id, { enabled })}
                      aria-label={`${method.name || paymentChannelLabel(method.channel)}付款方式`}
                    />
                  </td>
                  <td className="px-4 py-3 text-center">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => removeMethod(method.id)}
                      disabled={draft.length <= 1 || saving}
                      title="删除付款方式"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="divide-y overflow-hidden rounded-md border bg-card sm:hidden">
          {draft.map((method) => (
            <div key={method.id} className="grid gap-3 p-4">
              <div className="flex items-center justify-between gap-3">
                <Input
                  value={method.name}
                  onChange={(event) => updateMethod(method.id, { name: event.target.value })}
                  placeholder="付款方式名称"
                  className="min-w-0 flex-1"
                />
                <Switch
                  checked={method.enabled}
                  onCheckedChange={(enabled) => updateMethod(method.id, { enabled })}
                  aria-label={`${method.name || paymentChannelLabel(method.channel)}付款方式`}
                />
              </div>
              <Select
                value={method.channel}
                onValueChange={(channel) => updateMethod(method.id, { channel: channel as PaymentMethodSetting["channel"] })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PAYMENT_CHANNEL_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                value={method.account}
                onChange={(event) => updateMethod(method.id, { account: event.target.value })}
                placeholder="收款账户"
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => removeMethod(method.id)}
                disabled={draft.length <= 1 || saving}
              >
                <Trash2 className="size-4" />
                删除
              </Button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
