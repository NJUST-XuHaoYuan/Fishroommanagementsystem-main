import { useMemo, useState } from "react";
import { useStore } from "../store";
import { Card } from "./ui/card";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Search } from "lucide-react";

export function OperationLogsView() {
  const { state } = useStore();
  const [q, setQ] = useState("");
  const [module, setModule] = useState("all");

  if (state.user?.role !== "admin") {
    return (
      <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">
        当前账户没有操作日志查看权限。
      </div>
    );
  }

  const modules = useMemo(
    () => Array.from(new Set((state.operationLogs ?? []).map((log) => log.module))).filter(Boolean),
    [state.operationLogs]
  );

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (state.operationLogs ?? []).filter((log) => {
      if (module !== "all" && log.module !== module) return false;
      if (!term) return true;
      return [log.time, log.operator, log.module, log.action, log.detail]
        .some((v) => String(v ?? "").toLowerCase().includes(term));
    });
  }, [module, q, state.operationLogs]);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2>操作日志</h2>
        <p className="text-sm text-muted-foreground">查看系统内所有新增、修改和删除操作记录</p>
      </div>

      <div className="flex items-center gap-2">
        <div className="relative max-w-sm flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索操作人、模块、内容..." className="pl-9" />
        </div>
        <Select value={module} onValueChange={setModule}>
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部模块</SelectItem>
            {modules.map((m) => (
              <SelectItem key={m} value={m}>{m}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Card className="overflow-hidden">
        <table className="w-full">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-3 text-left text-sm">时间</th>
              <th className="px-4 py-3 text-left text-sm">操作人</th>
              <th className="px-4 py-3 text-left text-sm">模块</th>
              <th className="px-4 py-3 text-left text-sm">操作</th>
              <th className="px-4 py-3 text-left text-sm">详情</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center text-sm text-muted-foreground">暂无操作日志</td>
              </tr>
            ) : (
              filtered.slice(0, 100).map((log) => (
                <tr key={log.id} className="border-t">
                  <td className="px-4 py-3 text-sm">{new Date(log.time).toLocaleString()}</td>
                  <td className="px-4 py-3 text-sm">{log.operator}</td>
                  <td className="px-4 py-3 text-sm">{log.module}</td>
                  <td className="px-4 py-3 text-sm">{log.action}</td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">{log.detail}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </Card>
      {filtered.length > 100 && (
        <div className="text-xs text-muted-foreground">已显示最新 100 条，共 {filtered.length} 条匹配记录。</div>
      )}
    </div>
  );
}
