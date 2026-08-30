export function EmptyState({
  message,
  onRetry,
  retryLabel = "Retry",
}: {
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <div
      className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center"
      role={onRetry === undefined ? "status" : "alert"}
      aria-live={onRetry === undefined ? "polite" : "assertive"}
    >
      <p className="max-w-md text-sm text-muted-foreground">{message}</p>
      {onRetry !== undefined ? (
        <button
          type="button"
          className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent"
          onClick={onRetry}
        >
          {retryLabel}
        </button>
      ) : null}
    </div>
  );
}
