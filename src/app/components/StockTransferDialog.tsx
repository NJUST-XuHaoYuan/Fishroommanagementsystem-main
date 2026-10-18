import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRightLeft, RefreshCw, Search } from "lucide-react";
import { toast } from "sonner";
import { useStore, type StockTransferListItem } from "../store";
import { authHeaders } from "../utils/authSession";
import { usePermission } from "../utils/permissions";
import { createMaintenanceClientMutationId, maintenanceMutationTicket, type MaintenanceMutationTicket } from "../utils/maintenanceMutation";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Badge } from "./ui/badge";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { ImageWithFallback } from "./figma/ImageWithFallback";

export type StockTransferTarget = { subTankId: string; tankName: string };
const TRANSFERS_CHANGED = "fishroom-stock-transfers-changed";
const PAGE_SIZE = 50;

export function stockTransferRecordLabel(sourceType?: string): string {
  if (sourceType === "stockMove") return "移缸记录";
  if (sourceType === "stockTransferIssued") return "移缸签发";
  if (sourceType === "stockTransferReceived") return "移缸签收";
  return "";
}

/** Notify mounted pool counters without putting cross-site data into global state. */
export function notifyStockTransfersChanged() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(TRANSFERS_CHANGED));
}

export function transferSelectionKey(item: Pick<StockTransferListItem, "stockItemId" | "transferId">) {
  return JSON.stringify([item.stockItemId, item.transferId]);
}

export function filterStockTransfers(items: StockTransferListItem[], search: string, fromSiteId: string) {
  const term = search.trim().toLocaleLowerCase();
  return items.filter((item) => (!fromSiteId || item.fromSiteId === fromSiteId) && (!term ||
    [item.productName, item.size, item.origin, item.code, item.fromSiteName, item.fromTankName, item.issuedBy, item.notes]
      .join(" ").toLocaleLowerCase().includes(term)));
}

/** A re-issued fish is a different transfer and must be explicitly selected again. */
export function retainTransferSelection(selection: Set<string>, items: StockTransferListItem[]) {
  const available = new Set(items.map(transferSelectionKey));
  return new Set([...selection].filter((key) => available.has(key)));
}

export function toggleTransferPageSelection(selection: Set<string>, pageItems: StockTransferListItem[]) {
  const next = new Set(selection);
  const remove = pageItems.length > 0 && pageItems.every((item) => next.has(transferSelectionKey(item)));
  pageItems.forEach((item) => { const key = transferSelectionKey(item); if (remove) next.delete(key); else next.add(key); });
  return next;
}

export function stockTransferReceipt(targetSubTankId: string, selected: Set<string>, items: StockTransferListItem[]) {
  return {
    mode: "transferReceive" as const,
    targetSubTankId,
    items: items.filter((item) => selected.has(transferSelectionKey(item)))
      .map(({ stockItemId, transferId }) => ({ stockItemId, transferId })),
  };
}

function useStockTransferPool(active: boolean, refreshKey?: unknown) {
  const { state } = useStore();
  const [items, setItems] = useState<StockTransferListItem[]>([]);
  const [loading, setLoading] = useState(active);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => {
    setLoading(true);
    setRevision((value) => value + 1);
  }, []);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void fetch("/api/stock/transfers", { headers: authHeaders(), signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok || data.ok !== true || !Array.isArray(data.items)) {
          throw new Error(data.error || "在途列表加载失败，请重试");
        }
        if (!controller.signal.aborted) setItems(data.items);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "在途列表加载失败，请重试");
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [active, revision, refreshKey, state.user?.username]);
  useEffect(() => {
    if (!active) return;
    window.addEventListener(TRANSFERS_CHANGED, refresh);
    window.addEventListener("focus", refresh);
    return () => {
      window.removeEventListener(TRANSFERS_CHANGED, refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [active, refresh]);
  return { items, loading, error, refresh };
}

function issuedTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
}

export function StockTransferRows({ items, selectable = false, selected = new Set<string>(), disabled = false, onToggle }: {
  items: StockTransferListItem[];
  selectable?: boolean;
  selected?: Set<string>;
  disabled?: boolean;
  onToggle?: (key: string) => void;
}) {
  return <ul className="divide-y rounded-lg border" aria-label="移缸在途鱼列表">
    {items.map((item) => {
      const key = transferSelectionKey(item);
      return <li key={key} className="flex min-w-0 gap-3 p-3">
        {selectable && <label className="flex min-h-10 min-w-10 shrink-0 cursor-pointer items-start justify-center pt-2">
          <input type="checkbox" className="size-4 accent-slate-800" checked={selected.has(key)} disabled={disabled}
            aria-label={`选择 ${item.productName}${item.code ? `，编号 ${item.code}` : ""}，${item.fromSiteName} ${item.fromTankName}`}
            onChange={() => onToggle?.(key)} />
        </label>}
        <ImageWithFallback src={item.imageUrl} alt="" className="mt-1 size-12 shrink-0 rounded-md border object-cover" />
        <div className="min-w-0 flex-1 space-y-1 break-words">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{item.productName || item.productId}</span>
            <Badge variant="outline">{item.status === "sick" ? "疾病" : item.status === "feeding" ? "开口" : "正常"}</Badge>
            {item.sold && <Badge variant="outline">已售</Badge>}
          </div>
          <p className="text-xs text-muted-foreground">{[item.size, item.origin, item.code ? `编号 ${item.code}` : "未编号"].filter(Boolean).join(" · ")}</p>
          <p className="text-sm">来源：{item.fromSiteName} / {item.fromTankName}</p>
          <p className="text-xs text-muted-foreground">签发：{issuedTime(item.issuedAt)} · {item.issuedBy || "—"}</p>
          {item.notes && <p className="whitespace-pre-wrap text-xs text-muted-foreground">备注：{item.notes}</p>}
        </div>
      </li>;
    })}
  </ul>;
}

export function StockTransferDialog({ open, onOpenChange, target, onReceived }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target?: StockTransferTarget;
  onReceived?: () => void;
}) {
  const { state, saveMaintenanceAction } = useStore();
  const permission = usePermission("daily");
  const pool = useStockTransferPool(open && permission.canUpdate);
  const [search, setSearch] = useState("");
  const [fromSiteId, setFromSiteId] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [conflict, setConflict] = useState(false);
  const requestLock = useRef(false);
  const ticketRef = useRef<MaintenanceMutationTicket | null>(null);
  const targetAvailable = !!target && state.tankGroups.some((group) => group.subTanks.some((tank) => tank.id === target.subTankId));
  const canReceive = !!target && permission.canUpdate && targetAvailable;
  const sources = useMemo(() => [...new Map(pool.items.map((item) => [item.fromSiteId, item.fromSiteName])).entries()], [pool.items]);
  const filtered = useMemo(() => filterStockTransfers(pool.items, search, fromSiteId), [pool.items, search, fromSiteId]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const pageItems = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const selectedItems = pool.items.filter((item) => selected.has(transferSelectionKey(item)));
  const hiddenSelectedCount = selectedItems.filter((item) => !filtered.includes(item)).length;
  const allPageSelected = pageItems.length > 0 && pageItems.every((item) => selected.has(transferSelectionKey(item)));
  useEffect(() => {
    if (!open) return;
    setSearch(""); setFromSiteId(""); setPage(0); setSelected(new Set()); setSaveError(""); setConflict(false);
    ticketRef.current = null;
  }, [open, target?.subTankId]);
  useEffect(() => {
    if (pool.loading || pool.error) return;
    setSelected((current) => retainTransferSelection(current, pool.items));
  }, [pool.items, pool.loading, pool.error]);
  const toggle = (key: string) => setSelected((current) => {
    const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next;
  });
  const receive = async () => {
    if (requestLock.current || !target || !permission.requirePermission("update")) return;
    if (!targetAvailable) return setSaveError("目标缸不可用或无场地权限，请关闭后重新选择目标缸。");
    if (!selectedItems.length || pool.loading || pool.error || conflict) return;
    const change = stockTransferReceipt(target.subTankId, selected, pool.items);
    const ticket = maintenanceMutationTicket(ticketRef.current, change, createMaintenanceClientMutationId);
    ticketRef.current = ticket;
    requestLock.current = true; setSaving(true); setSaveError("");
    try {
      const result = await saveMaintenanceAction({ ...change, clientMutationId: ticket.clientMutationId });
      if (!result.ok) {
        setConflict(result.conflict === true);
        setSaveError(`${result.error || "签收失败，请重试"}${result.conflict ? "。请刷新在途列表后重新确认，仍在途的选择会保留。" : ""}`);
        return;
      }
      setSelected(new Set()); ticketRef.current = null;
      toast.success(`已签收入缸 ${selectedItems.length} 条`);
      notifyStockTransfersChanged(); onReceived?.();
    } catch (reason) {
      setSaveError(reason instanceof Error ? reason.message : "签收失败，请重试；已选鱼仍保留。");
    } finally { requestLock.current = false; setSaving(false); }
  };
  const refresh = () => { if (requestLock.current) return; setConflict(false); setSaveError(""); pool.refresh(); };
  if (!permission.canUpdate) return null;
  return <Dialog open={open} onOpenChange={(next) => { if (!requestLock.current) onOpenChange(next); }}>
    <DialogContent aria-describedby="stock-transfer-description" className="flex max-h-[90dvh] max-w-3xl flex-col overflow-hidden p-4 sm:p-6">
      <DialogHeader className="shrink-0 pr-6"><DialogTitle>{target ? "签收入缸" : "移缸在途"}</DialogTitle></DialogHeader>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
        <div id="stock-transfer-description" className="space-y-1 text-sm">
          {target ? <><p className="break-words font-medium">目标缸：{target.tankName}</p><p className="text-muted-foreground">勾选已到达的鱼，确认后放入此缸。可分批签收，也可签回原缸。</p></> :
            <p className="text-muted-foreground">全场地在途鱼。请到目标子缸点击「签收入缸」；在途期间不展示在鱼单、不能新售或实际出库。</p>}
        </div>
        {!permission.canUpdate || (target && !canReceive) ? <p role="alert" className="text-sm text-destructive">无签收权限或目标缸不可用，请返回已授权场地的目标缸。</p> : null}
        <div className="flex flex-wrap gap-2">
          <div className="relative min-w-0 flex-1 basis-48"><Search className="absolute left-3 top-3 size-4 text-muted-foreground" /><Input className="h-10 pl-9" aria-label="搜索在途鱼" placeholder="商品 / 编号 / 来源缸 / 备注" value={search} disabled={saving} onChange={(event) => { setSearch(event.target.value); setPage(0); }} /></div>
          <Select value={fromSiteId || "all"} disabled={saving} onValueChange={(value) => { setFromSiteId(value === "all" ? "" : value); setPage(0); }}>
            <SelectTrigger className="h-10 w-full sm:w-40" aria-label="筛选来源场地"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="all">全部来源场地</SelectItem>{sources.map(([id, name]) => <SelectItem key={id} value={id}>{name}</SelectItem>)}</SelectContent>
          </Select>
          <Button className="min-h-10" variant="outline" onClick={refresh} disabled={saving || pool.loading}><RefreshCw className="mr-1 size-4" />刷新</Button>
        </div>
        {saveError && <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">{saveError}</div>}
        {pool.loading ? <p role="status" className="py-8 text-center text-sm text-muted-foreground">正在加载在途列表…</p> : pool.error ?
          <div role="alert" className="py-6 text-center text-sm"><p>{pool.error}</p><Button className="mt-2" variant="outline" onClick={refresh}>重试</Button></div> : <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span className="text-muted-foreground">符合筛选 {filtered.length} / 全部 {pool.items.length} 条</span>
            {canReceive && <><span>已选 {selectedItems.length} 条{hiddenSelectedCount > 0 ? `（筛选外 ${hiddenSelectedCount} 条）` : ""}</span>
              <Button size="sm" variant="ghost" className="min-h-10" disabled={saving || !pageItems.length} onClick={() => setSelected((current) => toggleTransferPageSelection(current, pageItems))}>{allPageSelected ? "取消本页" : "全选本页"}</Button>
              {selected.size > 0 && <Button size="sm" variant="ghost" className="min-h-10" disabled={saving} onClick={() => setSelected(new Set())}>清空选择</Button>}</>}
          </div>
          {filtered.length ? <StockTransferRows items={pageItems} selectable={canReceive} selected={selected} disabled={saving} onToggle={toggle} /> :
            <p className="py-8 text-center text-sm text-muted-foreground">{pool.items.length ? "没有符合条件的在途鱼，可修改搜索或来源筛选。" : "暂无移缸在途的鱼。签发移缸后会出现在这里。"}</p>}
          {pageCount > 1 && <div className="flex items-center justify-center gap-3 text-sm"><Button variant="outline" disabled={saving || currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</Button><span>{currentPage + 1} / {pageCount}</span><Button variant="outline" disabled={saving || currentPage + 1 >= pageCount} onClick={() => setPage(currentPage + 1)}>下一页</Button></div>}
        </>}
      </div>
      <DialogFooter className="shrink-0 border-t pt-3"><Button variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>关闭</Button>
        {canReceive && <Button onClick={receive} disabled={saving || pool.loading || !!pool.error || conflict || !selectedItems.length}>{saving ? "签收中…" : `确认签收 ${selectedItems.length} 条`}</Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

export function StockTransferPoolButton({ className, refreshKey }: { className?: string; refreshKey?: unknown }) {
  const [open, setOpen] = useState(false);
  const permission = usePermission("daily");
  const pool = useStockTransferPool(permission.canUpdate, refreshKey);
  if (!permission.canUpdate) return null;
  return <>
    <Button type="button" variant="outline" className={className} onClick={() => setOpen(true)}>
      <ArrowRightLeft className="mr-1 size-4" />移缸在途{pool.loading ? " …" : pool.error ? "（待刷新）" : ` ${pool.items.length}`}
    </Button>
    <StockTransferDialog open={open} onOpenChange={setOpen} />
  </>;
}
