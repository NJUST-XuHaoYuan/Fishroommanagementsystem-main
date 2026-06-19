import { useState } from "react";
import { useStore } from "../store";
import { Card } from "./ui/card";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Button } from "./ui/button";
import { toast } from "sonner";
import { saveAuthSession } from "../utils/authSession";
import { ArrowRight, LockKeyhole, Waves } from "lucide-react";

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
      saveAuthSession(user, typeof result.token === "string" ? result.token : undefined, result.expiresAt);
      setState((s) => ({ ...s, user }));
      toast.success(`欢迎，${user.username}`);
    } catch {
      toast.error("用户名或密码错误");
    } finally {
      setLoggingIn(false);
    }
  };

  return (
    <div className="fishroom-login flex min-h-screen items-center justify-center p-4 sm:p-6">
      <div className="grid w-full max-w-5xl gap-4 lg:grid-cols-[minmax(0,1fr)_26rem]">
        <section className="fishroom-login-aside hidden min-h-[34rem] rounded-2xl p-8 lg:flex lg:flex-col lg:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <div className="fishroom-login-logo-mark grid size-[5.75rem] place-items-center overflow-hidden">
                <img src="/assets/brand-logo.jpg" alt="Marine Forest" className="fishroom-login-logo-image" />
              </div>
              <div className="fishroom-login-brand-copy">
                <div className="fishroom-login-brand-title">进销存管理系统</div>
                <div className="fishroom-login-brand-subtitle">面向库存、维护和销售的运营台</div>
              </div>
            </div>
            <div className="mt-12 max-w-xl">
              <h1 className="text-[2rem] font-semibold leading-tight text-balance">
                从在每一个缸个体到每一条维护记录，每一步都回到真实情况。
              </h1>
              <p className="mt-4 max-w-[34rem] text-sm leading-7 opacity-80">
                请仔细核对每一条操作
              </p>
            </div>
          </div>
          <div className="grid gap-3 text-sm">
            <div className="flex items-center gap-2">
              <Waves className="size-4" />
              <span>数据集中维护，减少重复录入和遗漏</span>
            </div>
            <div className="flex items-center gap-2">
              <LockKeyhole className="size-4" />
              <span>后台数据按账号权限进入，不暴露客户和成本信息</span>
            </div>
          </div>
        </section>

        <Card className="fishroom-login-panel rounded-2xl p-6 sm:p-8">
          <div className="mb-7 flex items-center gap-3 lg:hidden">
            <div className="fishroom-login-logo-mark grid size-20 place-items-center overflow-hidden">
              <img src="/assets/brand-logo.jpg" alt="Marine Forest" className="fishroom-login-logo-image" />
            </div>
            <div className="fishroom-login-brand-copy">
              <h1 className="fishroom-login-brand-title">进销存管理系统</h1>
              <p className="fishroom-login-brand-subtitle text-muted-foreground">登录以继续</p>
            </div>
          </div>

          <div className="hidden lg:block">
            <div className="inline-flex rounded-full border bg-secondary px-3 py-1 text-xs font-medium text-secondary-foreground">
              员工入口
            </div>
            <h2 className="fishroom-page-title mt-4">登录后台</h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">使用人员管理中维护的账号进入系统。</p>
          </div>

          <div className="mt-7 flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="u">用户名</Label>
              <Input id="u" value={u} onChange={(e) => setU(e.target.value)} autoComplete="username" />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="p">密码</Label>
              <Input
                id="p"
                type="password"
                value={p}
                onChange={(e) => setP(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submit()}
                autoComplete="current-password"
              />
            </div>
            <Button onClick={submit} className="h-11 w-full" disabled={loggingIn}>
              {loggingIn ? "登录中…" : "登录后台"}
              {!loggingIn && <ArrowRight className="size-4" />}
            </Button>
            <div className="rounded-lg bg-muted px-3 py-2 text-xs leading-relaxed text-muted-foreground">
              后台账号只用于内部库存、维护和销售操作。
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
