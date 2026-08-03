import { useState } from "react";
import { ShieldCheck, UsersRound } from "lucide-react";
import { PermissionsView } from "./PermissionsView";
import { PersonnelView } from "./PersonnelView";
import { Button } from "./ui/button";

type PersonnelSection = "accounts" | "permissions";

export function PersonnelAdminView() {
  const [section, setSection] = useState<PersonnelSection>("accounts");

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2>人员与权限</h2>
        <p className="text-sm text-muted-foreground">集中维护员工账号、登录密码、可见区域和业务权限</p>
      </div>

      <div
        role="tablist"
        aria-label="人员与权限管理"
        className="grid w-full grid-cols-2 gap-1 rounded-md border bg-muted/40 p-1 sm:w-[19rem]"
      >
        <Button
          type="button"
          role="tab"
          aria-selected={section === "accounts"}
          variant={section === "accounts" ? "default" : "ghost"}
          size="sm"
          className="h-8"
          onClick={() => setSection("accounts")}
        >
          <UsersRound className="size-4" />
          人员账号
        </Button>
        <Button
          type="button"
          role="tab"
          aria-selected={section === "permissions"}
          variant={section === "permissions" ? "default" : "ghost"}
          size="sm"
          className="h-8"
          onClick={() => setSection("permissions")}
        >
          <ShieldCheck className="size-4" />
          权限设置
        </Button>
      </div>

      <div hidden={section !== "accounts"}>
        <PersonnelView embedded />
      </div>
      <div hidden={section !== "permissions"}>
        <PermissionsView embedded />
      </div>
    </div>
  );
}
