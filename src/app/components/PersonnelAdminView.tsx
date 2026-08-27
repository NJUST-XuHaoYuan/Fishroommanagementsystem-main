import { ShieldCheck, UsersRound } from "lucide-react";
import { PermissionsView } from "./PermissionsView";
import { PersonnelView } from "./PersonnelView";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";

export function PersonnelAdminView() {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2>人员与权限</h2>
        <p className="text-sm text-muted-foreground">
          先维护完整人员档案，再按需开通登录账号并配置访问权限
        </p>
      </div>

      <Tabs defaultValue="profiles" className="gap-4">
        <TabsList
          aria-label="人员与权限管理"
          className="grid h-auto w-full grid-cols-2 rounded-md border bg-muted/40 p-1 sm:w-[22rem]"
        >
          <TabsTrigger value="profiles" className="min-h-11 rounded-md">
            <UsersRound className="size-4" aria-hidden="true" />
            人员档案
          </TabsTrigger>
          <TabsTrigger value="accounts" className="min-h-11 rounded-md">
            <ShieldCheck className="size-4" aria-hidden="true" />
            账号与权限
          </TabsTrigger>
        </TabsList>

        <TabsContent value="profiles" forceMount className="data-[state=inactive]:hidden">
          <PersonnelView embedded />
        </TabsContent>
        <TabsContent value="accounts" forceMount className="data-[state=inactive]:hidden">
          <PermissionsView embedded />
        </TabsContent>
      </Tabs>
    </div>
  );
}
