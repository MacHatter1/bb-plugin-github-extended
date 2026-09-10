import { Button } from "../shared-ui.js";

export function EmptyState({
  title,
  message,
  onRetry,
  retryLabel = "Retry",
  actionLabel,
  onAction,
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div
      className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center"
      role={onRetry === undefined ? "status" : "alert"}
      aria-live={onRetry === undefined ? "polite" : "assertive"}
    >
      <span
        className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground"
        aria-hidden="true"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          {onRetry === undefined ? (
            <>
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3-3" />
            </>
          ) : (
            <>
              <circle cx="12" cy="12" r="9" />
              <path d="M12 8v5" />
              <path d="M12 16h.01" />
            </>
          )}
        </svg>
      </span>
      {title !== undefined ? (
        <p className="text-sm font-medium text-foreground">{title}</p>
      ) : null}
      <p className="max-w-md text-sm text-muted-foreground">{message}</p>
      {onRetry !== undefined || onAction !== undefined ? (
        <div className="flex flex-wrap items-center justify-center gap-2">
          {onRetry !== undefined ? (
            <Button type="button" size="sm" variant="outline" onClick={onRetry}>
              {retryLabel}
            </Button>
          ) : null}
          {onAction !== undefined && actionLabel !== undefined ? (
            <Button type="button" size="sm" variant={onRetry === undefined ? "outline" : "ghost"} onClick={onAction}>
              {actionLabel}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
