import { useMemo, useRef, useState, ReactNode } from "react";
import { Input } from "../../app/components/ui/input";
import { Button } from "../../app/components/ui/button";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
  PaginationEllipsis,
} from "../../app/components/ui/pagination";
import { Search, Plus } from "lucide-react";

type Column<T> = {
  key: string;
  title: ReactNode;
  render?: (row: T) => ReactNode;
  width?: string;
};

type Props<T> = {
  data: T[];
  columns: Column<T>[];
  searchKeys: (keyof T)[];
  pageSize?: number;
  onAdd?: () => void;
  addLabel?: string;
  actions?: (row: T) => ReactNode;
  searchPlaceholder?: string;
  searchRank?: (row: T, query: string) => number;
  onRowDoubleClick?: (row: T) => void;
};

export function DataTable<T extends { id: string }>({
  data,
  columns,
  searchKeys,
  pageSize = 8,
  onAdd,
  addLabel = "新增",
  actions,
  searchPlaceholder = "搜索...",
  searchRank,
  onRowDoubleClick,
}: Props<T>) {
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const tableRootRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    if (!q.trim()) return data;
    if (searchRank) {
      return data
        .map((row, index) => ({ row, index, rank: searchRank(row, q) }))
        .filter(({ rank }) => Number.isFinite(rank))
        .sort((left, right) => left.rank - right.rank || left.index - right.index)
        .map(({ row }) => row);
    }
    const term = q.toLowerCase();
    return data.filter((row) =>
      searchKeys.some((k) => String(row[k] ?? "").toLowerCase().includes(term))
    );
  }, [data, q, searchKeys, searchRank]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const current = Math.min(page, totalPages);
  const slice = filtered.slice((current - 1) * pageSize, current * pageSize);
  const visiblePageTokens = useMemo<(number | "start-ellipsis" | "end-ellipsis")[]>(() => {
    if (totalPages <= 7) return Array.from({ length: totalPages }, (_, index) => index + 1);

    let start = Math.max(2, current - 2);
    let end = Math.min(totalPages - 1, current + 2);

    if (current <= 4) {
      start = 2;
      end = 5;
    } else if (current >= totalPages - 3) {
      start = totalPages - 4;
      end = totalPages - 1;
    }

    const tokens: (number | "start-ellipsis" | "end-ellipsis")[] = [1];
    if (start > 2) tokens.push("start-ellipsis");
    for (let pageNumber = start; pageNumber <= end; pageNumber += 1) {
      tokens.push(pageNumber);
    }
    if (end < totalPages - 1) tokens.push("end-ellipsis");
    tokens.push(totalPages);
    return tokens;
  }, [current, totalPages]);

  const scrollTableToTop = () => {
    window.requestAnimationFrame(() => {
      const root = tableRootRef.current;
      if (!root) return;
      const scrollContainer = root.closest(".fishroom-content") as HTMLElement | null;
      if (scrollContainer) {
        const rootRect = root.getBoundingClientRect();
        const containerRect = scrollContainer.getBoundingClientRect();
        const rootTop = scrollContainer.scrollTop + rootRect.top - containerRect.top - 16;
        scrollContainer.scrollTo({ top: Math.max(0, rootTop), left: 0, behavior: "auto" });
        return;
      }
      root.scrollIntoView({ block: "start", behavior: "auto" });
    });
  };

  const changePage = (nextPage: number) => {
    const normalized = Math.max(1, Math.min(totalPages, nextPage));
    setPage(normalized);
    scrollTableToTop();
  };

  return (
    <div ref={tableRootRef} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1 sm:max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              changePage(1);
            }}
            placeholder={searchPlaceholder}
            className="fishroom-control pl-9"
          />
        </div>
        {onAdd && (
          <Button onClick={onAdd} className="w-full sm:w-auto">
            <Plus className="size-4" /> {addLabel}
          </Button>
        )}
      </div>
      <div className="fishroom-table-shell hidden overflow-x-auto rounded-xl md:block">
        <table className="w-full">
          <thead>
            <tr>
              {columns.map((c) => (
                <th
                  key={c.key}
                  className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground"
                  style={c.width ? { width: c.width } : undefined}
                >
                  {c.title}
                </th>
              ))}
              {actions && <th className="w-40 px-4 py-3 text-right text-xs font-semibold text-muted-foreground">操作</th>}
            </tr>
          </thead>
          <tbody>
            {slice.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length + (actions ? 1 : 0)}
                  className="px-4 py-14 text-center text-sm text-muted-foreground"
                >
                  {q.trim() ? "没有符合搜索条件的记录。" : "暂无数据，使用上方操作新增记录。"}
                </td>
              </tr>
            ) : (
              slice.map((row) => (
                <tr
                  key={row.id}
                  className={`border-t transition-colors ${onRowDoubleClick ? "cursor-pointer" : ""}`}
                  onDoubleClick={() => onRowDoubleClick?.(row)}
                >
                  {columns.map((c, index) => (
                    <td key={c.key} className={`px-4 py-3 text-sm ${index === 0 ? "font-medium text-foreground" : ""}`}>
                      {c.render ? c.render(row) : String((row as any)[c.key] ?? "")}
                    </td>
                  ))}
                  {actions && <td className="px-4 py-3 text-right">{actions(row)}</td>}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="flex flex-col gap-3 md:hidden">
        {slice.length === 0 ? (
          <div className="fishroom-card rounded-xl px-4 py-10 text-center text-sm text-muted-foreground">
            {q.trim() ? "没有符合搜索条件的记录。" : "暂无数据，使用上方操作新增记录。"}
          </div>
        ) : (
          slice.map((row) => (
            <div
              key={row.id}
              className={`fishroom-card rounded-xl p-4 ${onRowDoubleClick ? "cursor-pointer" : ""}`}
              onDoubleClick={() => onRowDoubleClick?.(row)}
            >
              <div className="flex flex-col gap-3">
                {columns.map((c, index) => (
                  <div
                    key={c.key}
                    className={
                      index === 0
                        ? "text-sm font-medium text-foreground"
                        : "grid grid-cols-[5.5rem_1fr] gap-3 text-sm"
                    }
                  >
                    {index === 0 ? (
                      c.render ? c.render(row) : String((row as any)[c.key] ?? "")
                    ) : (
                      <>
                        <span className="text-muted-foreground">{c.title}</span>
                        <div className="min-w-0 break-words text-foreground">
                          {c.render ? c.render(row) : String((row as any)[c.key] ?? "")}
                        </div>
                      </>
                    )}
                  </div>
                ))}
                {actions && (
                  <div className="border-t pt-3">
                    <div className="flex flex-wrap justify-end gap-2">{actions(row)}</div>
                  </div>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="flex flex-col gap-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
        <span>
          共 {filtered.length} 条 · 第 {current}/{totalPages} 页
        </span>
        <Pagination className="mx-0 w-auto">
          <PaginationContent>
            <PaginationItem>
              <PaginationPrevious
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  changePage(current - 1);
                }}
              />
            </PaginationItem>
            {visiblePageTokens.map((token) => (
              token === "start-ellipsis" || token === "end-ellipsis" ? (
                <PaginationItem key={token}>
                  <PaginationEllipsis />
                </PaginationItem>
              ) : (
                <PaginationItem key={token}>
                  <PaginationLink
                    href="#"
                    isActive={current === token}
                    onClick={(e) => {
                      e.preventDefault();
                      changePage(token);
                    }}
                  >
                    {token}
                  </PaginationLink>
                </PaginationItem>
              )
            ))}
            <PaginationItem>
              <PaginationNext
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  changePage(current + 1);
                }}
              />
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      </div>
    </div>
  );
}
