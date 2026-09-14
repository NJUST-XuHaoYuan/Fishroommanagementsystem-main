import { useId } from "react";
import type { StockPriceMode } from "../store";
import { stockPriceModeLabel } from "../utils/stockPricing";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

export function StockPriceField({ mode, value, productPrice, onModeChange, onPriceChange, disabled = false,
  allowDirectOverride = false, label = "单条售价（¥）", disabledReason }: {
  mode: StockPriceMode;
  value: string | number;
  productPrice?: number;
  onModeChange: (mode: "product" | "manual") => void;
  onPriceChange: (value: string) => void;
  disabled?: boolean;
  allowDirectOverride?: boolean;
  label?: string;
  disabledReason?: string;
}) {
  const id = useId();
  const follows = mode === "product";
  // Protected stock retains its historical price, even if its original mode followed products.
  const displayed = follows && !disabled ? productPrice ?? 0 : value;
  return <div className="grid min-w-0 content-start gap-2">
    <Label htmlFor={`${id}-price`}>{label}</Label>
    <Select value={mode} disabled={disabled} onValueChange={next => { if (next === "product" || next === "manual") onModeChange(next); }}>
      <SelectTrigger className="w-full min-w-0" aria-label={`${label}来源`}><SelectValue>{stockPriceModeLabel(mode)}</SelectValue></SelectTrigger>
      <SelectContent>
        <SelectItem value="product">跟随商品价</SelectItem>
        <SelectItem value="manual">单独定价</SelectItem>
        {mode === "legacy" && <SelectItem value="legacy" disabled>历史价格待确认</SelectItem>}
      </SelectContent>
    </Select>
    <Input id={`${id}-price`} type="number" inputMode="decimal" min={0.01} step={0.01}
      value={displayed === 0 ? "" : displayed} placeholder="0.00" disabled={disabled}
      readOnly={follows && !allowDirectOverride} aria-describedby={`${id}-hint`}
      onChange={event => onPriceChange(event.target.value)} />
    <p id={`${id}-hint`} className="text-xs leading-relaxed text-muted-foreground">
      {disabled ? disabledReason || "已售或关联订单的库存保留原价，历史订单价不受影响。"
        : follows ? allowDirectOverride ? "默认随商品改价；直接修改金额会改为单独定价。" : "商品改价时同步；要调整这条鱼，请先选择单独定价。"
          : mode === "manual" ? "只用于这条鱼，不随商品改价。"
            : "保留历史售价；确认后可选择跟随商品价或单独定价。"}
    </p>
  </div>;
}
