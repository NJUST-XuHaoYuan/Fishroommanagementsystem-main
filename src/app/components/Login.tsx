import { useState } from "react";
import { useStore } from "../store";
import { Card } from "./ui/card";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Button } from "./ui/button";
import { toast } from "sonner";
import { saveAuthSession } from "../utils/authSession";

export function Login() {
  const { setState } = useStore();
  const [u, setU] = useState("admin");
  const [p, setP] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);

  const submit = async () => {
    const username = u.trim();
    if (!username || !p) {
      toast.error("请输入用户名和密码");
      return;
    }
    setLoggingIn(true);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password: p }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok || !result.user) {
        throw new Error(result.error || `HTTP ${response.status}`);
      }
      const user = {
        username: String(result.user.username ?? ""),
        role: result.user.role === "admin" ? "admin" as const : "staff" as const,
      };
      saveAuthSession(user, undefined, result.expiresAt);
      setState((s) => ({ ...s, user }));
      toast.success(`欢迎，${user.username}`);
    } catch {
      toast.error("用户名或密码错误");
    } finally {
      setLoggingIn(false);
    }
  };

  return (
    <div className="size-full min-h-screen flex items-center justify-center bg-slate-50 p-6">
      <Card className="w-full max-w-md p-8">
        <div className="flex flex-col items-center gap-2 mb-6">
          <div className="size-16 overflow-hidden rounded-2xl border bg-white">
            <img src="/assets/brand-logo.jpg" alt="Marine Forest" className="size-full object-contain p-1" />
          </div>
          <h1>海水鱼房管理系统</h1>
          <p className="text-sm text-muted-foreground">登录以继续</p>
        </div>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="u">用户名</Label>
            <Input id="u" value={u} onChange={(e) => setU(e.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="p">密码</Label>
            <Input id="p" type="password" value={p} onChange={(e) => setP(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
          </div>
          <Button onClick={submit} className="w-full" disabled={loggingIn}>
            {loggingIn ? "登录中…" : "登录"}
          </Button>
          <div className="text-xs text-muted-foreground text-center leading-relaxed">
            请输入账号密码登录，账号可在人员管理中维护
          </div>
        </div>
      </Card>
    </div>
  );
}
