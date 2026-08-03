import { useEffect, useMemo, useState } from "react";
import {
  normalizePaymentMethodSettings,
  paymentChannelLabel,
  PaymentMethodSetting,
  useStore,
} from "../store";
import { confirmWrite } from "../utils/writeConfirm";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Switch } from "./ui/switch";
import { Save, WalletCards } from "lucide-react";
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

  const updateMethod = (channel: PaymentMethodSetting["channel"], patch: Partial<PaymentMethodSetting>) => {
    setDraft((current) => current.map((method) =>
      method.channel === channel ? { ...method, ...patch } : method
    ));
  };

  const save = async () => {
    if (state.user?.role !== "admin" || saving) return;
    const normalized = draft.map((method) => ({
      ...method,
      account: method.account.trim(),
    }));
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
            <p className="mt-1 text-sm text-muted-foreground">维护订单可选付款方式和对应默认收款账户</p>
          </div>
          <Button onClick={() => void save()} disabled={!changed || saving}>
            <Save className="size-4" />
            {saving ? "保存中..." : "保存配置"}
          </Button>
        </div>

        <div className="hidden overflow-hidden rounded-md border bg-card sm:block">
          <table className="w-full table-fixed text-sm">
            <thead className="bg-muted/50 text-left text-foreground">
              <tr>
                <th className="w-[24%] px-4 py-3 font-semibold">付款方式</th>
                <th className="px-4 py-3 font-semibold">默认收款账户</th>
                <th className="w-28 px-4 py-3 text-center font-semibold">状态</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {draft.map((method) => (
                <tr key={method.channel}>
                  <td className="px-4 py-3 font-medium">{paymentChannelLabel(method.channel)}</td>
                  <td className="px-4 py-3">
                    <Input
                      value={method.account}
                      onChange={(event) => updateMethod(method.channel, { account: event.target.value })}
                      placeholder="账户名称或银行卡尾号"
                    />
                  </td>
                  <td className="px-4 py-3 text-center">
                    <Switch
                      checked={method.enabled}
                      onCheckedChange={(enabled) => updateMethod(method.channel, { enabled })}
                      aria-label={`${paymentChannelLabel(method.channel)}付款方式`}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="divide-y overflow-hidden rounded-md border bg-card sm:hidden">
          {draft.map((method) => (
            <div key={method.channel} className="grid gap-3 p-4">
              <div className="flex items-center justify-between gap-3">
                <span className="font-medium">{paymentChannelLabel(method.channel)}</span>
                <Switch
                  checked={method.enabled}
                  onCheckedChange={(enabled) => updateMethod(method.channel, { enabled })}
                  aria-label={`${paymentChannelLabel(method.channel)}付款方式`}
                />
              </div>
              <Input
                value={method.account}
                onChange={(event) => updateMethod(method.channel, { account: event.target.value })}
                placeholder="默认收款账户"
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
