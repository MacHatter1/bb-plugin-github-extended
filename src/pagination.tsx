import { useEffect, useId, useState } from "react";
import { Button } from "./shared-ui.js";

type PageSize = 25 | 50 | 100;
const DEFAULT_PAGE_SIZE = 25;
const PAGE_SIZES: PageSize[] = [25, 50, 100];

export function usePagination(total: number, resetKey = "") {
  const [state, setState] = useState<{ page: number; pageSize: PageSize; resetKey: string }>({ page: 0, pageSize: DEFAULT_PAGE_SIZE, resetKey });
  const pageCount = Math.max(1, Math.ceil(total / state.pageSize));
  const page = state.resetKey === resetKey ? Math.min(state.page, pageCount - 1) : 0;
  useEffect(() => {
    setState((current) =>
      current.resetKey === resetKey && current.page === page
        ? current
        : { ...current, resetKey, page },
    );
  }, [resetKey, page]);
  return {
    page,
    pageSize: state.pageSize,
    pageCount,
    offset: page * state.pageSize,
    end: Math.min((page + 1) * state.pageSize, total),
    setPage: (next: number) => setState({ ...state, resetKey, page: Math.max(0, Math.min(next, pageCount - 1)) }),
    setPageSize: (pageSize: PageSize) => setState({ resetKey, page: 0, pageSize }),
  };
}

export function PaginationControls({
  label,
  total,
  pagination,
  position = "top",
}: {
  label: string;
  total: number;
  pagination: ReturnType<typeof usePagination>;
  position?: "top" | "bottom";
}) {
  const sizeId = useId();
  if (total <= DEFAULT_PAGE_SIZE) return null;
  const { page, pageSize, pageCount, offset, end, setPage, setPageSize } = pagination;
  const returnToStart = (control: HTMLElement) => {
    if (position === "bottom") {
      control.closest("[data-pagination-region]")
        ?.querySelector<HTMLElement>('.gh-pagination[data-position="top"]')
        ?.scrollIntoView({ block: "start" });
    }
  };
  const goToPage = (next: number, control: HTMLElement) => {
    setPage(next);
    returnToStart(control);
  };
  return (
    <nav className="gh-pagination" data-position={position} aria-label={`${label} pagination${position === "bottom" ? " (bottom)" : ""}`}>
      <div className="gh-pagination-summary">
        <span aria-live={position === "top" ? "polite" : undefined}>
          Showing {offset + 1}–{end} of {total}
        </span>
        <label htmlFor={sizeId}>
          Rows
          <select
            id={sizeId}
            aria-label={`${label} per page`}
            value={pageSize}
            onChange={(event) => {
              const size = PAGE_SIZES.find((value) => String(value) === event.target.value);
              if (size) {
                setPageSize(size);
                returnToStart(event.currentTarget);
              }
            }}
          >
            {PAGE_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
          </select>
        </label>
      </div>
      <div className="gh-pagination-buttons">
        <Button size="sm" variant="ghost" aria-label="First page" disabled={page === 0} onClick={(event) => goToPage(0, event.currentTarget)}>First</Button>
        <Button size="sm" variant="outline" aria-label="Previous page" disabled={page === 0} onClick={(event) => goToPage(page - 1, event.currentTarget)}>Previous</Button>
        <span>Page {page + 1} of {pageCount}</span>
        <Button size="sm" variant="outline" aria-label="Next page" disabled={page + 1 >= pageCount} onClick={(event) => goToPage(page + 1, event.currentTarget)}>Next</Button>
        <Button size="sm" variant="ghost" aria-label="Last page" disabled={page + 1 >= pageCount} onClick={(event) => goToPage(pageCount - 1, event.currentTarget)}>Last</Button>
      </div>
    </nav>
  );
}
