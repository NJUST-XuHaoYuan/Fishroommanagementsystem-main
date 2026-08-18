import { useState } from "react";
import { useStore, TankGroup, SubTank } from "../store";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Plus, Pencil, Trash2, Search } from "lucide-react";
import { toast } from "sonner";
import { getInventoryOutStockIds, isPhysicallyInTank } from "../utils/inventory";
import { usePermission } from "../utils/permissions";
import { confirmWrite } from "../utils/writeConfirm";

export function TankGroupsView() {
  const { state, saveTankGroupChange } = useStore();
  const permission = usePermission("tankGroups");
  const [q, setQ] = useState("");
  const [saving, setSaving] = useState(false);
  const [editGroup, setEditGroup] = useState<TankGroup | null>(null);
  const [groupOpen, setGroupOpen] = useState(false);
  const [delGroup, setDelGroup] = useState<TankGroup | null>(null);

  const [editSub, setEditSub] = useState<{ groupId: string; sub: SubTank } | null>(null);
  const [subOpen, setSubOpen] = useState(false);
  const [delSub, setDelSub] = useState<{ groupId: string; sub: SubTank } | null>(null);
  const shippedOutStockIds = getInventoryOutStockIds(state);

  const filtered = state.tankGroups.filter(
    (g) => !q || g.name.includes(q) || g.location.includes(q)
  );

  const stockCount = (subId: string) =>
    state.stock.filter((s) => s.subTankId === subId && isPhysicallyInTank(s, shippedOutStockIds)).length;

  const groupStockCount = (group: TankGroup) =>
    group.subTanks.reduce((total, tank) => total + stockCount(tank.id), 0);

  const requestDeleteGroup = (group: TankGroup) => {
    if (!permission.requirePermission("delete")) return;
    const count = groupStockCount(group);
    if (count > 0) {
      toast.error(`该缸组还有 ${count} 条在缸库存，不能删除`);
      return;
    }
    setDelGroup(group);
  };

  const requestDeleteSub = (groupId: string, sub: SubTank) => {
    if (!permission.requirePermission("delete")) return;
    const count = stockCount(sub.id);
    if (count > 0) {
      toast.error(`该子缸还有 ${count} 条在缸库存，不能删除`);
      return;
    }
    setDelSub({ groupId, sub });
  };

  const saveGroup = async () => {
    if (!editGroup) return;
    if (!permission.requirePermission(editGroup.id ? "update" : "create")) return;
    if (!editGroup.name.trim()) return toast.error("请填写缸组名");

    // 检查缸组名是否重复
    const duplicate = state.tankGroups.find(
      (g) => g.id !== editGroup.id && g.name === editGroup.name.trim()
    );
    if (duplicate) return toast.error("缸组名已存在，请使用不同的名称");

    if (!confirmWrite(editGroup.id ? "修改" : "新增", editGroup.id ? "将保存缸组信息的修改。" : "将新增一个缸组。")) return;
    setSaving(true);
    const ok = await saveTankGroupChange({ mode: "upsertGroup", group: editGroup });
    setSaving(false);
    if (!ok) return toast.error("保存失败，请重试");
    setGroupOpen(false);
    toast.success("已保存");
  };

  const saveSub = async () => {
    if (!editSub) return;
    if (!permission.requirePermission(editSub.sub.id ? "update" : "create")) return;
    if (!editSub.sub.name.trim()) return toast.error("请填写子缸名");

    // 检查同缸组内子缸名是否重复
    const targetGroup = state.tankGroups.find((g) => g.id === editSub.groupId);
    if (targetGroup) {
      const duplicate = targetGroup.subTanks.find(
        (t) => t.id !== editSub.sub.id && t.name === editSub.sub.name.trim()
      );
      if (duplicate) return toast.error("该缸组内已存在同名子缸，请使用不同的名称");
    }

    if (!confirmWrite(editSub.sub.id ? "修改" : "新增", editSub.sub.id ? "将保存子缸信息的修改。" : "将新增一个子缸。")) return;
    setSaving(true);
    const ok = await saveTankGroupChange({ mode: "upsertSubTank", groupId: editSub.groupId, subTank: editSub.sub });
    setSaving(false);
    if (!ok) return toast.error("保存失败，请重试");
    setSubOpen(false);
    toast.success("已保存");
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2>缸组管理</h2>
          <p className="text-sm text-muted-foreground">管理鱼房中的缸组及子缸结构</p>
        </div>
        <div className="flex gap-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索缸组..." className="pl-9 w-64" />
          </div>
          {permission.canCreate && (
            <Button onClick={() => { setEditGroup({ id: "", name: "", location: "", subTanks: [] }); setGroupOpen(true); }}>
              <Plus className="size-4" /> 新建缸组
            </Button>
          )}
        </div>
      </div>

      {filtered.length === 0 ? (
        <Card className="p-12 text-center text-muted-foreground text-sm">暂无缸组</Card>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {filtered.map((g) => (
            <Card key={g.id} className="p-5 border-2 border-sky-200 bg-sky-50/40">
              <div className="flex items-start justify-between mb-4">
                <div>
                  <h3>{g.name}</h3>
                  <div className="text-xs text-muted-foreground mt-1">
                    {g.location || "未填写位置"} · {g.subTanks.length}个子缸
                  </div>
                </div>
	                <div className="flex gap-1">
	                  {permission.canUpdate && (
	                    <Button size="icon" variant="ghost" onClick={() => { setEditGroup({ ...g }); setGroupOpen(true); }}>
	                      <Pencil className="size-4" />
	                    </Button>
	                  )}
		                  {permission.canDelete && (
		                    <Button size="icon" variant="ghost" className="text-red-600" onClick={() => requestDeleteGroup(g)}>
		                      <Trash2 className="size-4" />
		                    </Button>
		                  )}
	                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
                {g.subTanks.map((t) => (
                  <div key={t.id} className="bg-white border rounded-md p-3 flex flex-col gap-1 group relative">
                    <div className="text-sm">{t.name}</div>
                    <div className="text-xs text-muted-foreground">在缸 {stockCount(t.id)}</div>
	                    {(permission.canUpdate || permission.canDelete) && (
	                      <div className="absolute top-1 right-1 hidden group-hover:flex gap-0.5 bg-white/95 rounded">
	                        {permission.canUpdate && (
	                          <button className="p-1 hover:bg-muted rounded" onClick={() => { setEditSub({ groupId: g.id, sub: { ...t } }); setSubOpen(true); }}>
	                            <Pencil className="size-3" />
	                          </button>
	                        )}
		                        {permission.canDelete && (
		                          <button className="p-1 hover:bg-muted rounded text-red-600" onClick={() => requestDeleteSub(g.id, t)}>
		                            <Trash2 className="size-3" />
		                          </button>
		                        )}
	                      </div>
	                    )}
	                  </div>
	                ))}
	                {permission.canCreate && (
	                  <button
	                    onClick={() => { setEditSub({ groupId: g.id, sub: { id: "", name: "" } }); setSubOpen(true); }}
	                    className="border-2 border-dashed rounded-md p-3 text-sm text-muted-foreground hover:bg-white hover:border-sky-300 hover:text-sky-700 flex items-center justify-center gap-1"
	                  >
	                    <Plus className="size-4" /> 子缸
	                  </button>
	                )}
              </div>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={groupOpen} onOpenChange={setGroupOpen}>
        <DialogContent aria-describedby={undefined}>
          <DialogHeader><DialogTitle>{editGroup?.id ? "编辑缸组" : "新建缸组"}</DialogTitle></DialogHeader>
          {editGroup && (
            <div className="grid gap-4 py-2">
              <div className="grid gap-2">
                <Label>缸组名</Label>
                <Input value={editGroup.name} onChange={(e) => setEditGroup({ ...editGroup, name: e.target.value })} />
              </div>
              <div className="grid gap-2">
                <Label>位置</Label>
                <Input value={editGroup.location} onChange={(e) => setEditGroup({ ...editGroup, location: e.target.value })} />
              </div>
            </div>
          )}
          <DialogFooter>
	            <Button variant="outline" onClick={() => setGroupOpen(false)} disabled={saving}>取消</Button>
	            <Button onClick={saveGroup} disabled={saving}>{saving ? "保存中…" : "保存"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={subOpen} onOpenChange={setSubOpen}>
        <DialogContent aria-describedby={undefined}>
          <DialogHeader><DialogTitle>{editSub?.sub.id ? "编辑子缸" : "新增子缸"}</DialogTitle></DialogHeader>
          {editSub && (
            <div className="grid gap-4 py-2">
              <div className="grid gap-2">
                <Label>子缸名</Label>
                <Input value={editSub.sub.name} onChange={(e) => setEditSub({ ...editSub, sub: { ...editSub.sub, name: e.target.value } })} />
              </div>
            </div>
          )}
          <DialogFooter>
	            <Button variant="outline" onClick={() => setSubOpen(false)} disabled={saving}>取消</Button>
	            <Button onClick={saveSub} disabled={saving}>{saving ? "保存中…" : "保存"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!delGroup} onOpenChange={(o) => !o && setDelGroup(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除缸组</AlertDialogTitle>
	            <AlertDialogDescription>
	              删除「{delGroup?.name}」将同时移除其下全部子缸。该操作不可撤销；如果缸组内还有在缸库存，系统会拒绝删除。
	            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
		            <AlertDialogAction disabled={saving} onClick={async () => {
		              if (!delGroup) return;
		              if (!permission.requirePermission("delete")) return;
		              const count = groupStockCount(delGroup);
		              if (count > 0) {
		                toast.error(`该缸组还有 ${count} 条在缸库存，不能删除`);
		                setDelGroup(null);
		                return;
		              }
		              if (!confirmWrite("删除", `将删除缸组「${delGroup.name}」及其下全部子缸。`)) return;
		              setSaving(true);
		              const ok = await saveTankGroupChange({ mode: "deleteGroup", groupId: delGroup.id });
		              setSaving(false);
		              if (!ok) {
		                toast.error("删除失败，请刷新后重试");
		                return;
		              }
	              setDelGroup(null);
	              toast.success("已删除");
	            }}>确认删除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!delSub} onOpenChange={(o) => !o && setDelSub(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除子缸</AlertDialogTitle>
	            <AlertDialogDescription>
	              确认删除「{delSub?.sub.name}」？该操作不可撤销；如果子缸内还有在缸库存，系统会拒绝删除。
	            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
		            <AlertDialogAction disabled={saving} onClick={async () => {
		              if (!delSub) return;
		              if (!permission.requirePermission("delete")) return;
		              const count = stockCount(delSub.sub.id);
		              if (count > 0) {
		                toast.error(`该子缸还有 ${count} 条在缸库存，不能删除`);
		                setDelSub(null);
		                return;
		              }
		              if (!confirmWrite("删除", `将删除子缸「${delSub.sub.name}」。`)) return;
		              setSaving(true);
		              const ok = await saveTankGroupChange({ mode: "deleteSubTank", groupId: delSub.groupId, subTankId: delSub.sub.id });
		              setSaving(false);
		              if (!ok) {
		                toast.error("删除失败，请刷新后重试");
		                return;
		              }
	              setDelSub(null);
	              toast.success("已删除");
	            }}>确认删除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
