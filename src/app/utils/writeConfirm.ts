export type WriteAction = "保存" | "新增" | "修改" | "删除" | "创建" | "移缸" | "登记损耗" | "发货" | "退款" | "完成";

export function confirmWrite(action: WriteAction | string = "保存", detail?: string) {
  if (typeof window === "undefined") return true;
  const suffix = action.endsWith("？") ? action : `确认${action}本次操作？`;
  return window.confirm(detail ? `${detail}\n${suffix}` : suffix);
}
