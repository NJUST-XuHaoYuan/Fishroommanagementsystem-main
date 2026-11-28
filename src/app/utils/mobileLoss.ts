import type { MaintenanceSaveChange, MaintenanceStockExpectedSnapshot, StockItem } from "../store";
import { maintenanceStockExpectedSnapshot } from "./maintenanceMutation";
import { isPhysicallyInTank } from "./inventory";

export type MobileLossItem = { expected: MaintenanceStockExpectedSnapshot; label: string; imageUrl: string; inDate: string };
export type MobileLossRequest = Extract<MaintenanceSaveChange, { mode: "loss" }>;

/** Freeze before taking photos. Re-reading stock after the camera closes defeats CAS. */
export function freezeMobileLossItems(items: StockItem[], subTankId: string, outIds: Set<string>, label: (item: StockItem) => string, imageUrl: (item: StockItem) => string): MobileLossItem[] {
  return items.filter(item => item.subTankId === subTankId && isPhysicallyInTank(item, outIds)).map(item => ({
    expected: maintenanceStockExpectedSnapshot(item), label: label(item), imageUrl: imageUrl(item), inDate: item.inDate || "",
  }));
}

export function mobileLossValidation(items: MobileLossItem[], date: string, today: string, photos: string[]) {
  if (!items.length) return "请选择要报损的鱼。";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return "请选择损耗日期。";
  if (date > today) return "损耗日期不能晚于今天。";
  const minimum = items.reduce((latest, item) => item.inDate.slice(0, 10) > latest ? item.inDate.slice(0, 10) : latest, "");
  if (minimum && date < minimum) return `损耗日期不能早于最晚入库日期 ${minimum}。`;
  if (!photos.length) return "请先拍摄或上传报损照片。";
  return "";
}

/** A retry keeps this complete immutable request, even after store deltas arrive. */
export function mobileLossRequest(id: string, items: MobileLossItem[], date: string, reason: string, photos: string[]): MobileLossRequest {
  return { mode: "loss", clientMutationId: id, itemIds: items.map(item => item.expected.id), expectedItems: items.map(item => ({ ...item.expected })), lossDate: date, lossReason: reason.trim(), lossProof: [...photos] };
}
