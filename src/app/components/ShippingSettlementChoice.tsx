import { useId } from "react";
import type { ShippingSettlementTiming } from "../store";

export function ShippingSettlementChoice({ value, onChange, disabled = false }: {
  value: ShippingSettlementTiming;
  onChange: (value: ShippingSettlementTiming) => void;
  disabled?: boolean;
}) {
  const groupId = useId();
  return (
    <fieldset disabled={disabled} className="min-w-0 space-y-2 disabled:opacity-60">
      <legend className="mb-2 text-sm font-medium">运费结算时间</legend>
      {([
        ["before_shipping", "先结算运费", "预计运费计入本次应收，发货后多退少补。"],
        ["after_shipping", "发货后结算运费", "本次先收商品款，运费确定后再收。"],
      ] as const).map(([timing, label, hint]) => (
        <label key={timing} className={`flex min-h-14 cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2.5 ${value === timing ? "border-foreground bg-muted/40" : "hover:bg-muted/30"} ${disabled ? "cursor-default" : ""}`}>
          <input type="radio" name={groupId} value={timing} checked={value === timing} onChange={() => onChange(timing)} className="mt-0.5 size-4 shrink-0 accent-current" />
          <span className="min-w-0"><span className="block text-sm font-medium">{label}</span><span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{hint}</span></span>
        </label>
      ))}
    </fieldset>
  );
}
