export type DashboardSalespersonOption = { name: string; amount: number; orderCount: number };

export function rankDashboardSalespeople(options: DashboardSalespersonOption[]): DashboardSalespersonOption[] {
  return [...options].sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name, "zh-CN"));
}

// null means automatic top five; an empty Set is an intentional empty selection.
export function dashboardSalespersonSelection(options: DashboardSalespersonOption[], selection: Set<string> | null): string[] {
  const ranked = rankDashboardSalespeople(options);
  return selection === null
    ? ranked.filter((option) => option.orderCount > 0).slice(0, 5).map((option) => option.name)
    : ranked.filter((option) => selection.has(option.name)).map((option) => option.name);
}
