import { useState } from "react";
import { useStore } from "../store";
import { Card } from "./ui/card";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Button } from "./ui/button";
import { toast } from "sonner";
import { saveAuthSession } from "../utils/authSession";

export function Login() {
  const { state, setState } = useStore();
  const [u, setU] = useState("admin");
  const [p, setP] = useState("");

  const submit = () => {
    const username = u.trim();
    const account = (state.personnel ?? []).find(
      (person) => person.username === username && person.password === p
    );

    if (!account) {
      toast.error("用户名或密码错误");
      return;
    }

    const user = { username: account.username, role: account.accessRole };
    saveAuthSession(user);
    setState((s) => ({ ...s, user }));
    toast.success(`欢迎，${account.name || account.username}`);
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
          <Button onClick={submit} className="w-full">登录</Button>
          <div className="text-xs text-muted-foreground text-center leading-relaxed">
            请输入账号密码登录，账号可在人员管理中维护
          </div>
        </div>
      </Card>
    </div>
  );
}
