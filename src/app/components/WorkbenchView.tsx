import type { ReactNode } from "react";
import { ClipboardList, PackageSearch, ShoppingBag } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";

export type WorkbenchSection = "maintenance" | "sales" | "inventory";

export function WorkbenchView({ section, onSectionChange, children }: {
  section: WorkbenchSection;
  onSectionChange: (section: WorkbenchSection) => void;
  children: ReactNode;
}) {
  return <section className="min-w-0 space-y-5" aria-label="工作台">
    <Tabs value={section} onValueChange={value => onSectionChange(value as WorkbenchSection)} className="min-w-0 gap-5">
      <TabsList aria-label="工作板块" className="workbench-three-columns grid h-auto w-full grid-cols-3 gap-1 rounded-lg p-1 sm:w-fit">
        <TabsTrigger value="maintenance" className="min-h-11 gap-2 px-3 sm:px-7"><ClipboardList className="size-4 shrink-0" aria-hidden="true" />维护</TabsTrigger>
        <TabsTrigger value="sales" className="min-h-11 gap-2 px-3 sm:px-7"><ShoppingBag className="size-4 shrink-0" aria-hidden="true" />销售</TabsTrigger>
        <TabsTrigger value="inventory" className="min-h-11 gap-2 px-3 sm:px-7"><PackageSearch className="size-4 shrink-0" aria-hidden="true" />库存管理</TabsTrigger>
      </TabsList>
      <TabsContent value={section} className="min-w-0 outline-none">{children}</TabsContent>
    </Tabs>
  </section>;
}
