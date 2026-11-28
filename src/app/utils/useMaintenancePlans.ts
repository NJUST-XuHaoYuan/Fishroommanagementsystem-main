import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { authJsonHeaders } from "./authSession";
import { captureNewCustomerSession, isNewCustomerSessionCurrent } from "./newCustomerEvidence";
import { createMaintenanceClientMutationId } from "./maintenanceMutation";
import { readMaintenanceSnapshot, type MaintenanceSnapshot } from "./maintenanceWorkbench";

/** One server revision and one mutation ticket per logical request, including a lost response. */
export function useMaintenancePlans(enabled = true) {
  const { state, activeSiteId } = useStore();
  const context = JSON.stringify([activeSiteId, state.user?.username, state.user?.role, state.user?.account, state.user?.visibleSiteIds, captureNewCustomerSession()?.key]);
  const contextRef = useRef(context); contextRef.current = context;
  const [loaded, setLoaded] = useState<{ context: string; data: MaintenanceSnapshot } | null>(null);
  const snapshot = loaded?.context === context ? loaded.data : null;
  const snapshotRef = useRef(snapshot); snapshotRef.current = snapshot;
  const [loading, setLoading] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState("");
  const alive = useRef(false), lock = useRef(false), sequence = useRef(0);
  const ticket = useRef<{ key: string; body: object } | null>(null);
  useEffect(() => { alive.current = true; ticket.current = null; lock.current = false; setSaving(false); setLoaded(null); return () => { alive.current = false; sequence.current++; }; }, [context]);
  const refresh = useCallback(async () => {
    if (!enabled || activeSiteId === "all" || !state.user) return null;
    const session = captureNewCustomerSession(), captured = context, read = ++sequence.current;
    if (!session) { setError("登录已过期，请重新登录。"); return null; }
    const current = () => alive.current && contextRef.current === captured && read === sequence.current && isNewCustomerSessionCurrent(session);
    setLoading(true); setError("");
    try {
      const response = await fetch(`/api/maintenance-workbench?siteId=${encodeURIComponent(activeSiteId)}`, { headers: authJsonHeaders(), cache: "no-store" });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error || "维护计划加载失败，请重试。");
      const data = readMaintenanceSnapshot(payload, activeSiteId);
      if (current()) { setLoaded({ context: captured, data }); snapshotRef.current = data; return data; }
    } catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : "维护计划加载失败。"); }
    finally { if (current()) setLoading(false); }
    return null;
  }, [context, enabled]);
  useEffect(() => { void refresh(); }, [refresh]);
  const mutate = async (action: string, fields: Record<string, unknown>) => {
    if (lock.current) return null;
    const session = captureNewCustomerSession(), captured = context, data = snapshotRef.current;
    if (!session || !data) { setError("计划尚未加载，请刷新后重试。"); return null; }
    const current = () => alive.current && contextRef.current === captured && isNewCustomerSessionCurrent(session);
    const key = JSON.stringify([captured, action, fields]);
    if (ticket.current?.key !== key) ticket.current = { key, body: { siteId: activeSiteId, expectedRevision: data.revision, clientMutationId: createMaintenanceClientMutationId(), action, ...fields } };
    lock.current = true; setSaving(true); setError("");
    try {
      const response = await fetch("/api/maintenance-workbench", { method: "POST", headers: authJsonHeaders(), body: JSON.stringify(ticket.current.body) });
      const payload = await response.json();
      if (!current()) return null;
      if (!response.ok || !payload.ok) {
        if (response.status === 409) { ticket.current = null; await refresh(); }
        throw new Error(payload.error || "保存失败，内容已保留，请重试。");
      }
      const next = readMaintenanceSnapshot(payload, activeSiteId);
      if (current()) { ticket.current = null; snapshotRef.current = next; setLoaded({ context: captured, data: next }); return next; }
    } catch (cause) { if (current()) setError(cause instanceof TypeError ? "网络中断，内容已保留。请重试确认保存结果，不会重复登记。" : cause instanceof Error ? cause.message : "保存失败，内容已保留，请重试。"); }
    finally { if (current()) { lock.current = false; setSaving(false); } }
    return null;
  };
  return { snapshot, loading, saving, error, setError, refresh, mutate, context };
}
