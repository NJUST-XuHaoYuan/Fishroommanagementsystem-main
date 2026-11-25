import { cloneElement, isValidElement, useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactElement, type ReactNode } from "react";
import { Check, Loader2, Plus, RefreshCw } from "lucide-react";
import { isPersonnelAccountEnabled, useStore } from "../store";
import { authJsonHeaders } from "../utils/authSession";
import { captureNewCustomerSession, isNewCustomerSessionCurrent } from "../utils/newCustomerEvidence";
import { usePermission } from "../utils/permissions";
import { matchesSite, siteName } from "../utils/sites";
import {
  MAINTENANCE_STATUS, MAINTENANCE_TYPES, isActiveMaintenanceTask, maintenanceDateTime,
  maintenancePlanSchedule, maintenanceTaskList, maintenanceToday, parseMaintenanceMeasurements,
  readMaintenanceSnapshot, type MaintenanceSnapshot, type MaintenanceTask, type MaintenanceType, type MeasurementDraft,
} from "../utils/maintenanceWorkbench";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";

type TaskDraft = {
  title: string; type: MaintenanceType; tankId: string; subTankId: string; assignedTo: string;
  dueDate: string; dueTime: string; notes: string; frequency: "daily" | "weekly"; weekdays: number[];
};
type Editor = "task" | "plan" | "handoff" | "complete" | "cancel" | null;
const newTask = (): TaskDraft => ({ title: "", type: "inspection", tankId: "", subTankId: "", assignedTo: "", dueDate: maintenanceToday(), dueTime: "", notes: "", frequency: "daily", weekdays: [] });
const controlClass = "min-h-11 min-w-0 rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50";
const historyLabels: Record<string, string> = { create_task: "安排任务", start_task: "开始执行", complete_task: "完成任务", cancel_task: "取消任务", create_plan: "创建计划", set_plan_enabled: "调整计划", add_handoff: "写交接", materialize_task: "计划生成任务" };

function Field({ label, children, wide = false }: { label: string; children: ReactNode; wide?: boolean }) {
  const generatedId = useId();
  const control = isValidElement(children) ? children as ReactElement<{ id?: string }> : null;
  const id = control?.props.id || generatedId;
  return <div className={`grid min-w-0 gap-1.5 text-sm ${wide ? "sm:col-span-2" : ""}`}>
    <label htmlFor={id} className="font-medium">{label}</label>
    {control ? cloneElement(control, { id }) : children}
  </div>;
}

export function MaintenanceWorkbench({ onOpenDaily }: { onOpenDaily?: () => void }) {
  const { state, activeSiteId } = useStore();
  const permission = usePermission("daily");
  const canRead = permission.canCreate || permission.canUpdate || permission.canDelete;
  const contextKey = JSON.stringify([activeSiteId, state.user?.username, state.user?.role, state.user?.visibleSiteIds, state.user?.account, captureNewCustomerSession()?.key]);
  const contextRef = useRef(contextKey); contextRef.current = contextKey;
  const [loaded, setLoaded] = useState<{ context: string; data: MaintenanceSnapshot } | null>(null);
  const data = loaded?.context === contextKey ? loaded.data : null;
  const [loading, setLoading] = useState(false), [saving, setSaving] = useState(false);
  const [error, setError] = useState(""), [message, setMessage] = useState("");
  const [tab, setTab] = useState("today"), [scope, setScope] = useState<"due" | "all" | "upcoming">("due");
  const [taskType, setTaskType] = useState(""), [owner, setOwner] = useState("");
  const [historyLimit, setHistoryLimit] = useState(30);
  const [editor, setEditor] = useState<Editor>(null), [target, setTarget] = useState<MaintenanceTask | null>(null);
  const [draft, setDraft] = useState<TaskDraft>(newTask);
  const [result, setResult] = useState(""), [medicine, setMedicine] = useState("");
  const [measurements, setMeasurements] = useState<MeasurementDraft[]>([{ name: "", value: "" }]);
  const [handoff, setHandoff] = useState({ content: "", assignedTo: "", followUpAt: "", taskId: "" });
  const [formError, setFormError] = useState("");
  const readAbort = useRef<AbortController | null>(null), writeAbort = useRef<AbortController | null>(null);
  const readSequence = useRef(0), writeLock = useRef(false), mounted = useRef(false);
  const today = maintenanceToday();
  const tanks = state.tankGroups.filter(group => matchesSite(group, activeSiteId));
  const personnel = state.personnel.filter(person => isPersonnelAccountEnabled(person)
    && (person.accessRole === "admin" || person.visibleSiteIds?.includes(activeSiteId)));
  const staff = useMemo(() => {
    const names = new Map(personnel.map(person => [person.username, person.name || person.username]));
    return [...names].map(([username, name]) => ({ username, name }));
  }, [state.personnel, activeSiteId, state.user?.username]);
  const personName = (username?: string) => username ? state.personnel.find(person => person.username === username)?.name || username : "待指派";
  const locationName = (item: { tankId?: string; subTankId?: string }) => {
    if (!item.tankId) return "全场 / 未指定缸位";
    const tank = state.tankGroups.find(group => group.id === item.tankId);
    return [tank?.name || "原缸组已移除", item.subTankId ? tank?.subTanks.find(sub => sub.id === item.subTankId)?.name || "原子缸已移除" : "整组"].join(" / ");
  };

  const refresh = async () => {
    if (!canRead || !state.user || activeSiteId === "all" || writeLock.current) return;
    const session = captureNewCustomerSession();
    if (!session) { setError("登录已过期，请重新登录。"); return; }
    const context = contextKey, site = activeSiteId, sequence = ++readSequence.current;
    readAbort.current?.abort(); const controller = new AbortController(); readAbort.current = controller;
    const current = () => mounted.current && !controller.signal.aborted && sequence === readSequence.current
      && contextRef.current === context && isNewCustomerSessionCurrent(session);
    setLoading(true); setError("");
    try {
      const response = await fetch(`/api/maintenance-workbench?siteId=${encodeURIComponent(site)}`, { headers: authJsonHeaders(), signal: controller.signal, cache: "no-store" });
      const payload = await response.json();
      if (!response.ok || payload.ok !== true) throw new Error(payload.error || "维护工作台加载失败，请重试。");
      const snapshot = readMaintenanceSnapshot(payload, site);
      if (current()) setLoaded({ context, data: snapshot });
    } catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : "维护工作台加载失败。"); }
    finally { if (mounted.current && contextRef.current === context && sequence === readSequence.current) setLoading(false); }
  };
  useEffect(() => {
    mounted.current = true; setLoaded(null); setEditor(null); setTarget(null); setError(""); setFormError(""); setMessage("");
    setOwner(""); setSaving(false); writeLock.current = false;
    void refresh();
    return () => { mounted.current = false; readSequence.current += 1; readAbort.current?.abort(); writeAbort.current?.abort(); };
  }, [contextKey, canRead]);

  const mutate = async (action: string, fields: Record<string, unknown>, successMessage: string): Promise<boolean> => {
    if (!data || writeLock.current || loading) return false;
    const session = captureNewCustomerSession();
    if (!session) { setFormError("登录已过期，请重新登录。"); return false; }
    const context = contextKey, site = activeSiteId, controller = new AbortController();
    const current = () => mounted.current && contextRef.current === context && !controller.signal.aborted && isNewCustomerSessionCurrent(session);
    readAbort.current?.abort(); readSequence.current += 1;
    writeAbort.current = controller; writeLock.current = true; setLoading(false); setSaving(true); setFormError(""); setError(""); setMessage("");
    try {
      const response = await fetch("/api/maintenance-workbench", { method: "POST", headers: authJsonHeaders(), signal: controller.signal,
        body: JSON.stringify({ siteId: site, expectedRevision: data.revision, action, ...fields }) });
      const payload = await response.json();
      if (!current()) return false;
      if (!response.ok || payload.ok !== true) {
        if (response.status === 409) {
          // Refresh stale revisions while retaining the user's form for an explicit retry.
          const latest = await fetch(`/api/maintenance-workbench?siteId=${encodeURIComponent(site)}`, { headers: authJsonHeaders(), signal: controller.signal, cache: "no-store" });
          const fresh = await latest.json();
          if (latest.ok && current()) setLoaded({ context, data: readMaintenanceSnapshot(fresh, site) });
        }
        throw new Error(payload.error || "保存失败，请重试。尚未保存的内容已保留。");
      }
      const snapshot = readMaintenanceSnapshot(payload, site);
      if (!current()) return false;
      setLoaded({ context, data: snapshot }); setMessage(successMessage); return true;
    } catch (cause) {
      if (current()) { const text = cause instanceof Error ? cause.message : "保存失败，请重试。"; setFormError(text); setError(text); }
      return false;
    } finally {
      if (writeAbort.current === controller) { writeAbort.current = null; writeLock.current = false; if (mounted.current && contextRef.current === context) setSaving(false); }
    }
  };

  const canCreate = Boolean(data?.permissions.canCreate && permission.canCreate), canUpdate = Boolean(data?.permissions.canUpdate && permission.canUpdate), canDelete = Boolean(data?.permissions.canDelete && permission.canDelete);
  const openTaskEditor = (mode: "task" | "plan", source?: MaintenanceTask) => {
    setDraft({ ...newTask(), ...(source ? { title: `跟进：${source.title}`, type: source.type, tankId: source.tankId || "", subTankId: source.subTankId || "", assignedTo: source.assignedTo || "", notes: `跟进任务：${source.title}\n${source.result || source.notes || ""}` } : {}) });
    setFormError(""); setEditor(mode);
  };
  const openTaskAction = (mode: "complete" | "cancel", task: MaintenanceTask) => {
    setTarget(task); setResult(""); setMedicine(""); setMeasurements([{ name: "", value: "" }]); setFormError(""); setEditor(mode);
  };
  const closeEditor = () => { if (!writeLock.current) { setEditor(null); setTarget(null); setFormError(""); } };
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (writeLock.current) return;
    try {
      let ok = false;
      if (editor === "task" || editor === "plan") {
        if (!draft.title.trim()) throw new Error("请填写任务名称。");
        if (editor === "plan" && draft.frequency === "weekly" && draft.weekdays.length === 0) throw new Error("请选择每周执行的星期。");
        const shared = { title: draft.title.trim(), type: draft.type, tankId: draft.tankId || undefined, subTankId: draft.subTankId || undefined,
          assignedTo: draft.assignedTo || undefined, dueTime: draft.dueTime || undefined, notes: draft.notes.trim() };
        ok = editor === "task" ? await mutate("create_task", { task: { ...shared, dueDate: draft.dueDate } }, "任务已安排。")
          : await mutate("create_plan", { plan: { ...shared, startDate: draft.dueDate, frequency: draft.frequency, weekdays: draft.weekdays, enabled: true } }, "重复计划已保存。");
      } else if (editor === "handoff") {
        if (!handoff.content.trim()) throw new Error("请填写交接内容。");
        ok = await mutate("add_handoff", { handoff: { content: handoff.content.trim(), assignedTo: handoff.assignedTo || undefined, followUpAt: handoff.followUpAt || undefined, taskId: handoff.taskId || undefined } }, "交接记录已保存。");
      } else if (editor === "complete" && target) {
        if (!result.trim()) throw new Error("请填写实际执行结果。");
        const values = parseMaintenanceMeasurements(measurements);
        ok = await mutate("complete_task", { taskId: target.id, result: result.trim(), ...(Object.keys(values).length ? { measurements: values } : {}), medicineDescription: medicine.trim() || undefined }, "实际执行结果已保存。");
      } else if (editor === "cancel" && target) {
        if (!result.trim()) throw new Error("请说明取消原因。");
        ok = await mutate("cancel_task", { taskId: target.id, reason: result.trim() }, "任务已取消，原记录仍保留。");
      }
      if (ok) { setEditor(null); setTarget(null); }
    } catch (cause) { setFormError(cause instanceof Error ? cause.message : "请检查填写内容。"); }
  };

  const tasks = maintenanceTaskList(data?.tasks || [], { date: today, type: tab === "treatment" ? "" : taskType, owner, scope: tab === "treatment" ? "all" : scope, treatmentOnly: tab === "treatment" });
  const taskRows = (list: MaintenanceTask[], empty: string) => list.length === 0 ? <div className="px-4 py-10 text-center text-sm text-muted-foreground">{empty}</div> : <ul className="divide-y">{list.map(task => <li key={task.id} className="px-4 py-4 sm:px-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2"><h3 className="break-words font-semibold">{task.title}</h3><Badge variant="outline">{MAINTENANCE_TYPES[task.type] || task.type}</Badge><Badge variant={task.status === "in_progress" ? "secondary" : "outline"}>{MAINTENANCE_STATUS[task.status] || task.status}</Badge>{isActiveMaintenanceTask(task) && task.dueDate < today && <span className="text-xs font-medium text-destructive">已逾期</span>}</div>
        <p className="break-words text-sm text-muted-foreground">{locationName(task)} · {personName(task.assignedTo)} · {task.dueDate} {task.dueTime === "23:59" ? "当天" : task.dueTime}</p>
        {task.notes && <p className="whitespace-pre-wrap break-words text-sm">{task.notes}</p>}
      </div>
      <div className="flex flex-wrap gap-2">
        {task.status === "pending" && canUpdate && <Button type="button" variant="outline" className="min-h-11" disabled={saving || loading} onClick={() => void mutate("start_task", { taskId: task.id }, "已记录开始执行。")}>开始执行</Button>}
        {isActiveMaintenanceTask(task) && canUpdate && <Button type="button" className="min-h-11" disabled={saving || loading} onClick={() => openTaskAction("complete", task)}>记录结果</Button>}
        {isActiveMaintenanceTask(task) && canDelete && <Button type="button" variant="ghost" className="min-h-11" disabled={saving || loading} onClick={() => openTaskAction("cancel", task)}>取消任务</Button>}
        {task.type === "treatment" && canCreate && <Button type="button" variant="outline" className="min-h-11" disabled={saving || loading} onClick={() => openTaskEditor("task", task)}>安排后续</Button>}
      </div>
    </div>
    <details className="mt-2 text-sm"><summary className="min-h-11 w-fit cursor-pointer py-3 text-muted-foreground">查看执行记录</summary>
      <div className="grid gap-1.5 border-t pt-3 text-sm">
        <p>安排：{task.createdByName || personName(task.createdBy)} · {maintenanceDateTime(task.createdAt)}</p>
        {task.startedAt && <p>开始：{task.startedByName || personName(task.startedBy)} · {maintenanceDateTime(task.startedAt)}</p>}
        {task.completedAt && <p>完成：{task.completedByName || personName(task.completedBy)} · {maintenanceDateTime(task.completedAt)}</p>}
        {task.result && <p className="whitespace-pre-wrap break-words">实际结果：{task.result}</p>}
        {task.medicineDescription && <p className="whitespace-pre-wrap break-words">实际用药：{task.medicineDescription}</p>}
        {Object.entries(task.measurements || {}).map(([name, value]) => <p key={name}>{name}：{value}</p>)}
        {task.cancelledAt && <p>取消：{task.cancelledByName || personName(task.cancelledBy)} · {maintenanceDateTime(task.cancelledAt)}{task.reason ? ` · ${task.reason}` : ""}</p>}
      </div>
    </details>
  </li>)}</ul>;

  if (!canRead) return <p className="py-8 text-sm text-muted-foreground">当前账号没有维护操作权限，请联系管理员分配权限。</p>;
  if (activeSiteId === "all") return <p className="py-8 text-sm text-muted-foreground">请先在右上角选择具体场地，再查看和安排维护任务。</p>;
  return <section className="min-w-0 space-y-4" aria-label="维护工作台">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="text-lg font-semibold">{siteName(state, activeSiteId)} · 维护工作</h2><p className="mt-1 text-sm text-muted-foreground">{today} · 任务安排、实际执行和班次交接</p></div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" className="min-h-11" disabled={loading || saving} onClick={() => void refresh()}><RefreshCw className={`size-4 ${loading ? "animate-spin motion-reduce:animate-none" : ""}`} />刷新</Button>
        {onOpenDaily && <Button type="button" variant="outline" className="min-h-11" onClick={onOpenDaily}>日常管理</Button>}
        {canCreate && <><Button type="button" variant="outline" className="min-h-11" disabled={loading || saving} onClick={() => { setHandoff({ content: "", assignedTo: "", followUpAt: "", taskId: "" }); setFormError(""); setEditor("handoff"); }}>写交接</Button><Button type="button" className="min-h-11" disabled={loading || saving} onClick={() => openTaskEditor("task")}><Plus className="size-4" />安排任务</Button></>}
      </div>
    </div>
    {error && <p role="alert" className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">{error}</p>}
    {message && <p role="status" className="flex items-center gap-2 text-sm"><Check className="size-4" />{message}</p>}
    {loading && !data ? <div aria-label="正在加载维护任务" aria-busy="true" className="space-y-3 py-4">{[1, 2, 3].map(value => <div key={value} className="h-16 rounded-md bg-muted motion-safe:animate-pulse" />)}</div> : data && <Tabs value={tab} onValueChange={value => { setTab(value); setHistoryLimit(30); }} className="gap-4">
      <TabsList className="h-auto max-w-full flex-wrap justify-start rounded-md"><TabsTrigger value="today" className="min-h-11 rounded-md">今日工作</TabsTrigger><TabsTrigger value="plans" className="min-h-11 rounded-md">重复计划</TabsTrigger><TabsTrigger value="treatment" className="min-h-11 rounded-md">治疗跟进</TabsTrigger><TabsTrigger value="history" className="min-h-11 rounded-md">执行记录</TabsTrigger></TabsList>
      {(tab === "today" || tab === "treatment") && <div className="flex flex-wrap items-end gap-3">
        {tab === "today" && <><Field label="任务范围"><select aria-label="任务范围" className={controlClass} value={scope} onChange={event => setScope(event.target.value as typeof scope)}><option value="due">今天及逾期待办</option><option value="all">全部待办</option><option value="upcoming">未来待办</option></select></Field><Field label="任务类型"><select aria-label="任务类型" className={controlClass} value={taskType} onChange={event => setTaskType(event.target.value)}><option value="">全部类型</option>{Object.entries(MAINTENANCE_TYPES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field></>}
        <Field label="负责人"><select aria-label="负责人筛选" className={controlClass} value={owner} onChange={event => setOwner(event.target.value)}><option value="">全部人员</option><option value="__unassigned">待指派</option>{staff.map(person => <option key={person.username} value={person.username}>{person.name}</option>)}</select></Field>
        <Button type="button" variant={owner === state.user?.username ? "secondary" : "outline"} className="min-h-11" aria-pressed={owner === state.user?.username} onClick={() => setOwner(owner === state.user?.username ? "" : state.user?.username || "")}>只看我的</Button>
        <span className="py-3 text-sm text-muted-foreground">{tasks.length} 项待办</span>
      </div>}
      <TabsContent value="today" className="space-y-4">
        <div className="overflow-hidden rounded-md border bg-background">{taskRows(tasks, data.tasks.length ? "没有符合筛选条件的待办，可切换任务范围或查看执行记录。" : "还没有维护任务。安排第一项任务后，执行人员就能在这里记录开始和结果。")}</div>
        <div className="border-t pt-4"><h3 className="mb-3 font-semibold">最新交接</h3>{data.handoffs.length ? <ul className="divide-y">{[...data.handoffs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5).map(item => <li key={item.id} className="py-3"><p className="whitespace-pre-wrap break-words text-sm">{item.content}</p><p className="mt-1 text-xs text-muted-foreground">{item.createdByName || personName(item.createdBy)} · {maintenanceDateTime(item.createdAt)}{item.assignedTo ? ` · 跟进人：${personName(item.assignedTo)}` : ""}{item.followUpAt ? ` · 跟进时间：${maintenanceDateTime(item.followUpAt)}` : ""}</p></li>)}</ul> : <p className="text-sm text-muted-foreground">尚无交接记录。需要下一班继续处理的事项，可通过“写交接”登记。</p>}</div>
      </TabsContent>
      <TabsContent value="plans" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm text-muted-foreground">按每日或每周计划生成任务；暂停计划不会取消已经生成的任务。</p>{canCreate && <Button type="button" className="min-h-11" disabled={saving || loading} onClick={() => openTaskEditor("plan")}><Plus className="size-4" />新增重复计划</Button>}</div>
        <div className="rounded-md border bg-background">{data.plans.length ? <ul className="divide-y">{data.plans.map(plan => <li key={plan.id} className="flex flex-wrap items-center justify-between gap-3 p-4"><div className="min-w-0 flex-1"><div className="flex flex-wrap gap-2"><h3 className="break-words font-semibold">{plan.title}</h3><Badge variant="outline">{plan.enabled ? "启用中" : "已暂停"}</Badge></div><p className="mt-1 text-sm text-muted-foreground">{maintenancePlanSchedule(plan)} · {locationName(plan)} · {personName(plan.assignedTo)} · {plan.startDate} 起</p>{plan.notes && <p className="mt-2 whitespace-pre-wrap break-words text-sm">{plan.notes}</p>}</div>{canUpdate && <Button type="button" variant="outline" className="min-h-11" disabled={saving || loading} onClick={() => void mutate("set_plan_enabled", { planId: plan.id, enabled: !plan.enabled }, plan.enabled ? "重复计划已暂停。" : "重复计划已启用。")}>{plan.enabled ? "暂停计划" : "启用计划"}</Button>}</li>)}</ul> : <p className="px-4 py-10 text-center text-sm text-muted-foreground">尚无重复计划。固定频率的巡检、测水质或喂食可在这里安排。</p>}</div>
      </TabsContent>
      <TabsContent value="treatment" className="space-y-3"><p className="text-sm text-muted-foreground">这里列出尚未完成的治疗任务。完成一次执行后，需继续观察时请安排后续任务；不会自动判断疗程结束。</p><div className="rounded-md border bg-background">{taskRows(tasks, "当前没有待执行的治疗跟进任务。可在“安排任务”中选择治疗跟进。")}</div></TabsContent>
      <TabsContent value="history" className="space-y-5">
        <section><h3 className="mb-3 font-semibold">已完成与已取消</h3><div className="rounded-md border bg-background">{taskRows([...data.tasks].filter(task => !isActiveMaintenanceTask(task)).sort((a, b) => (b.completedAt || b.cancelledAt || b.createdAt).localeCompare(a.completedAt || a.cancelledAt || a.createdAt)).slice(0, historyLimit), "还没有完成或取消记录。完成任务时填写的实测数据、实际用药和结果会保存在这里。")}</div></section>
        <section><h3 className="mb-3 font-semibold">操作与交接记录</h3>{data.history.length ? <ol className="divide-y">{[...data.history].sort((a, b) => b.at.localeCompare(a.at)).slice(0, historyLimit).map(item => <li key={item.id} className="py-3"><p className="break-words text-sm"><strong>{historyLabels[item.action] || item.action}</strong> · {item.title}</p>{item.detail && <p className="mt-1 whitespace-pre-wrap break-words text-sm">{item.detail}</p>}<p className="mt-1 text-xs text-muted-foreground">{item.operatorName || personName(item.operator)} · {maintenanceDateTime(item.at)}</p></li>)}</ol> : <p className="text-sm text-muted-foreground">尚无操作记录。</p>}</section>
        {(data.history.length > historyLimit || data.tasks.filter(task => !isActiveMaintenanceTask(task)).length > historyLimit) && <Button type="button" variant="outline" className="min-h-11" onClick={() => setHistoryLimit(value => value + 30)}>查看更多记录</Button>}
      </TabsContent>
    </Tabs>}
    <p className="border-t pt-3 text-xs leading-5 text-muted-foreground">本页保存工作台任务与执行记录。鱼只照片、视频及原有养护记录，请进入“日常管理”查看和登记。</p>

    <Dialog open={editor !== null} onOpenChange={open => { if (!open) closeEditor(); }}><DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl" onEscapeKeyDown={event => { if (saving) event.preventDefault(); }} onPointerDownOutside={event => { if (saving) event.preventDefault(); }}>
      <DialogHeader><DialogTitle>{editor === "task" ? "安排维护任务" : editor === "plan" ? "新增重复计划" : editor === "handoff" ? "写交接记录" : editor === "cancel" ? "取消任务" : "记录实际执行结果"}</DialogTitle><DialogDescription>{target && (editor === "complete" || editor === "cancel") ? `${target.title} · ${locationName(target)}` : `${siteName(state, activeSiteId)}场地 · 保存后其他有维护权限的人员可查看`}</DialogDescription></DialogHeader>
      <form onSubmit={event => void submit(event)} className="space-y-4">
        <fieldset disabled={saving} className="grid min-w-0 gap-4 sm:grid-cols-2">
          {(editor === "task" || editor === "plan") && <>
            <Field label="任务名称 *" wide><Input className="min-h-11" value={draft.title} required maxLength={120} placeholder="例如：A组晨间观察" onChange={event => setDraft(value => ({ ...value, title: event.target.value }))} /></Field>
            <Field label="任务类型"><select className={controlClass} value={draft.type} onChange={event => setDraft(value => ({ ...value, type: event.target.value as MaintenanceType }))}>{Object.entries(MAINTENANCE_TYPES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field>
            <Field label="负责人"><select className={controlClass} value={draft.assignedTo} onChange={event => setDraft(value => ({ ...value, assignedTo: event.target.value }))}><option value="">暂不指派</option>{staff.map(person => <option key={person.username} value={person.username}>{person.name}</option>)}</select></Field>
            <Field label="缸组"><select className={controlClass} value={draft.tankId} onChange={event => setDraft(value => ({ ...value, tankId: event.target.value, subTankId: "" }))}><option value="">全场 / 不指定缸位</option>{tanks.map(tank => <option key={tank.id} value={tank.id}>{tank.name}</option>)}</select></Field>
            <Field label="子缸"><select className={controlClass} disabled={!draft.tankId || saving} value={draft.subTankId} onChange={event => setDraft(value => ({ ...value, subTankId: event.target.value }))}><option value="">整组</option>{tanks.find(tank => tank.id === draft.tankId)?.subTanks.map(sub => <option key={sub.id} value={sub.id}>{sub.name}</option>)}</select></Field>
            <Field label={editor === "plan" ? "开始日期 *" : "计划日期 *"}><Input type="date" className="min-h-11" required min={editor === "plan" ? today : undefined} value={draft.dueDate} onChange={event => setDraft(value => ({ ...value, dueDate: event.target.value }))} /></Field>
            <Field label="计划完成时间（北京时间）"><Input type="time" className="min-h-11" value={draft.dueTime} onChange={event => setDraft(value => ({ ...value, dueTime: event.target.value }))} /></Field>
            {editor === "plan" && <><Field label="重复频率" wide><select className={controlClass} value={draft.frequency} onChange={event => setDraft(value => ({ ...value, frequency: event.target.value as "daily" | "weekly" }))}><option value="daily">每天</option><option value="weekly">每周指定日期</option></select></Field>{draft.frequency === "weekly" && <fieldset className="sm:col-span-2"><legend className="mb-2 text-sm font-medium">执行星期 *</legend><div className="flex flex-wrap gap-2">{["一", "二", "三", "四", "五", "六", "日"].map((day, index) => <label key={day} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm"><input type="checkbox" checked={draft.weekdays.includes(index + 1)} onChange={event => setDraft(value => ({ ...value, weekdays: event.target.checked ? [...value.weekdays, index + 1] : value.weekdays.filter(item => item !== index + 1) }))} />周{day}</label>)}</div></fieldset>}</>}
            <Field label="工作要求（选填）" wide><Textarea rows={3} maxLength={2000} value={draft.notes} placeholder="说明要做什么、完成后需要记录哪些实际结果" onChange={event => setDraft(value => ({ ...value, notes: event.target.value }))} /></Field>
          </>}
          {editor === "handoff" && <>
            <Field label="交接内容 *" wide><Textarea rows={4} maxLength={2000} required value={handoff.content} placeholder="涉及哪些缸、发现什么、下一班需要做什么" onChange={event => setHandoff(value => ({ ...value, content: event.target.value }))} /></Field>
            <Field label="跟进人（选填）"><select className={controlClass} value={handoff.assignedTo} onChange={event => setHandoff(value => ({ ...value, assignedTo: event.target.value }))}><option value="">暂不指定</option>{staff.map(person => <option key={person.username} value={person.username}>{person.name}</option>)}</select></Field>
            <Field label="跟进时间（北京时间，选填）"><Input type="datetime-local" className="min-h-11" value={handoff.followUpAt} onChange={event => setHandoff(value => ({ ...value, followUpAt: event.target.value }))} /></Field>
            <Field label="关联任务（选填）" wide><select className={controlClass} value={handoff.taskId} onChange={event => setHandoff(value => ({ ...value, taskId: event.target.value }))}><option value="">不关联</option>{data?.tasks.map(task => <option key={task.id} value={task.id}>{task.title} · {task.dueDate}</option>)}</select></Field>
          </>}
          {editor === "complete" && <>
            <Field label="实际执行结果 *" wide><Textarea rows={4} maxLength={3000} required value={result} placeholder="填写实际完成的内容、观察结果和需要继续处理的问题" onChange={event => setResult(event.target.value)} /></Field>
            {target?.type === "treatment" && <Field label="实际药品与用量（含单位，选填）" wide><Textarea rows={2} maxLength={2000} value={medicine} placeholder="按已确认方案记录实际执行情况；未用药请如实说明" onChange={event => setMedicine(event.target.value)} /></Field>}
            {target?.type === "measurement" && <div className="space-y-3 sm:col-span-2"><p className="text-sm font-medium">水质实测数据（选填）</p>{measurements.map((row, index) => <div key={index} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-end gap-2"><Field label={`项目 ${index + 1}（含单位）`}><Input className="min-h-11" value={row.name} placeholder="项目名称及单位" maxLength={60} onChange={event => setMeasurements(values => values.map((value, i) => i === index ? { ...value, name: event.target.value } : value))} /></Field><Field label="实测值"><Input type="number" step="any" className="min-h-11" value={row.value} placeholder="未填写" onChange={event => setMeasurements(values => values.map((value, i) => i === index ? { ...value, value: event.target.value } : value))} /></Field><Button type="button" variant="ghost" className="min-h-11 px-2" aria-label={`移除测量项目 ${index + 1}`} onClick={() => setMeasurements(values => values.filter((_, i) => i !== index))}>移除</Button></div>)}<Button type="button" variant="outline" className="min-h-11" disabled={measurements.length >= 20} onClick={() => setMeasurements(values => [...values, { name: "", value: "" }])}><Plus className="size-4" />增加测量项目</Button><p className="text-xs leading-5 text-muted-foreground">只填实际测得的数据，空白不会按 0 记录。无法测量时，请在执行结果中说明。</p></div>}
          </>}
          {editor === "cancel" && <Field label="取消原因 *" wide><Textarea rows={3} maxLength={2000} required value={result} placeholder="说明未执行或不再需要执行的原因" onChange={event => setResult(event.target.value)} /></Field>}
        </fieldset>
        {formError && <p role="alert" className="text-sm text-destructive">{formError}</p>}
        <DialogFooter><Button type="button" variant="outline" className="min-h-11" disabled={saving} onClick={closeEditor}>返回</Button><Button type="submit" className="min-h-11" disabled={saving || loading}>{saving && <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />}{saving ? "保存中…" : editor === "complete" ? "保存结果并完成" : editor === "cancel" ? "确认取消任务" : "保存"}</Button></DialogFooter>
      </form>
    </DialogContent></Dialog>
  </section>;
}
