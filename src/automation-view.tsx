// The Automation tab of the GitHub+ panel: setup checklist and per-repo
// enablement, the rule builder, the event/job queue with approvals, the
// audit trail, and gh polling controls. Everything reads one
// `automationDashboard` snapshot and refetches on "automation-changed".
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  useBbNavigate,
  useRealtime,
  useRpc,
  type PluginMessageDirectiveProps,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { githubRpcContract } from "./server.js";
import { AUTOMATION_PAGES, type AutomationPage, type GithubStatus, type Route } from "./app-logic.js";
import {
  ACTION_KINDS,
  ACTION_LABELS,
  CONDITION_FIELDS,
  CONDITION_FIELD_LABELS,
  CONDITION_OPERATORS,
  EVENT_KINDS,
  EVENT_LABELS,
  JOB_STATUS_LABELS,
  OPERATOR_LABELS,
  STARTER_RULES,
  TEMPLATE_PLACEHOLDERS,
  type AuditRecord,
  type AutomationDashboard,
  type AutomationRepository,
  type AutomationRule,
  type GithubQuota,
  type GithubQuotaBucket,
  type JobRecord,
  type PollStatus,
  type RuleCondition,
} from "./automation/domain.js";
import {
  POLL_INTERVAL_PRESETS,
  QUOTA_PAUSE_MAX,
  QUOTA_PAUSE_MIN,
  QUOTA_PAUSE_PRESETS,
  formatPollInterval,
} from "./automation/poller.js";
import { quotaFraction, quotaTone } from "./automation/quota.js";
import { Button, Input, Skeleton, Spinner, Textarea, cn } from "./shared-ui.js";
import { EmptyState } from "@/components/empty-state";

const PANEL_PATH = "github";
const PAGE_LABELS: Record<AutomationPage, string> = {
  setup: "Setup",
  rules: "Rules",
  events: "Events",
  audit: "Audit",
  polling: "Polling",
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(then).toLocaleDateString();
}

function formatWhen(iso: string | null): string {
  if (iso === null) return "—";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const delta = Math.round((then - Date.now()) / 1000);
  if (delta > 5) {
    if (delta < 60) return `in ${delta}s`;
    const minutes = Math.round(delta / 60);
    if (minutes < 60) return `in ${minutes}m`;
    return `in ${Math.round(minutes / 60)}h`;
  }
  if (delta < -5) return relativeTime(iso);
  return "now";
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

const uid = () =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

type Tone = "default" | "success" | "warning" | "danger" | "info";

const TONE_CLASSES: Record<Tone, string> = {
  default: "border-border bg-secondary text-secondary-foreground",
  success: "border-transparent bg-green-600/10 text-green-700 dark:bg-green-500/15 dark:text-green-400",
  warning: "border-transparent bg-amber-600/10 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400",
  danger: "border-transparent bg-destructive/15 text-destructive",
  info: "border-transparent bg-blue-600/10 text-blue-700 dark:bg-blue-500/15 dark:text-blue-400",
};

export function ToneBadge({ tone = "default", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium", TONE_CLASSES[tone], className)}>
      {children}
    </span>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
  loading = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
  loading?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-foreground" : "bg-input",
      )}
    >
      <span
        className={cn(
          "pointer-events-none block size-4 rounded-full bg-background shadow-sm transition-transform",
          loading && "animate-pulse",
          checked ? "translate-x-4" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

function SectionHeader({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {description !== undefined ? <p className="mt-0.5 text-xs text-muted-foreground">{description}</p> : null}
      </div>
      {action !== undefined ? <div className="shrink-0 self-start">{action}</div> : null}
    </div>
  );
}

function Chip({ selected, onToggle, label, ariaLabel }: { selected: boolean; onToggle: () => void; label: string; ariaLabel?: string }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={ariaLabel}
      onClick={onToggle}
      className={cn(
        "cursor-pointer rounded-full border px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        selected ? "border-foreground/25 bg-secondary text-foreground" : "border-border text-muted-foreground hover:bg-accent",
      )}
    >
      {label}
    </button>
  );
}

function StatCard({
  label,
  value,
  detail,
  onClick,
  ariaLabel,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  onClick?: () => void;
  ariaLabel?: string;
}) {
  const className = "rounded-lg border border-border bg-card px-3 py-2";
  const body = (
    <>
      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-sm font-semibold tabular-nums text-foreground">{value}</p>
      {detail !== undefined ? <p className="text-[10px] text-muted-foreground">{detail}</p> : null}
    </>
  );
  if (onClick === undefined) {
    return <div className={className}>{body}</div>;
  }
  return (
    <button
      type="button"
      aria-label={ariaLabel ?? label}
      onClick={onClick}
      className={cn(className, "cursor-pointer text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring")}
    >
      {body}
    </button>
  );
}

const selectClass =
  "h-8 rounded-md border border-input bg-transparent px-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

function useDashboard(): {
  data: AutomationDashboard | null;
  error: string | null;
  loading: boolean;
  refetch: () => Promise<void>;
} {
  const rpc = useRpc<typeof githubRpcContract>();
  const [data, setData] = useState<AutomationDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const requestRef = useRef(0);
  const refetch = useCallback(async () => {
    const requestId = ++requestRef.current;
    setLoading(true);
    try {
      const result = (await rpc.call("automationDashboard")) as AutomationDashboard;
      if (requestId !== requestRef.current) return;
      setData(result);
      setError(null);
    } catch (reason) {
      if (requestId !== requestRef.current) return;
      setError(errorText(reason));
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, [rpc]);
  useEffect(() => {
    void refetch();
    return () => {
      requestRef.current += 1;
    };
  }, [refetch]);
  useRealtime("automation-changed", () => {
    void refetch();
  });
  return { data, error, loading, refetch };
}

// ---------------------------------------------------------------------------
// Root view
// ---------------------------------------------------------------------------

export function AutomationView({
  status,
  page,
  navigate,
}: {
  status: GithubStatus | null;
  page: AutomationPage;
  navigate: (route: Route) => void;
}) {
  const { data, error, loading, refetch } = useDashboard();
  const go = useCallback((next: AutomationPage) => navigate({ view: "automation", page: next }), [navigate]);

  if (data === null && error !== null) {
    return (
      <EmptyState
        title="Couldn't load automation"
        message={`Could not load automation state: ${error}`}
        onRetry={() => void refetch()}
        retryLabel="Retry"
      />
    );
  }
  if (data === null) {
    return (
      <div className="flex flex-col gap-3" role="status" aria-busy="true" aria-label="Loading automation">
        <span className="sr-only">Loading automation</span>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} className="h-14 w-full" />
          ))}
        </div>
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const quotaPercent = data.quota.graphql === null
    ? null
    : Math.round((data.quota.graphql.remaining / Math.max(1, data.quota.graphql.limit)) * 100);

  return (
    <div className="flex flex-col gap-4" aria-busy={loading || undefined}>
      {error !== null ? (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2 text-xs text-red-600 dark:text-red-400">
          <span>Could not refresh automation state: {error}</span>
          <Button size="sm" variant="outline" className="h-7 shrink-0" onClick={() => void refetch()}>
            Retry
          </Button>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {data.dryRun ? (
          <ToneBadge tone="info">Dry run</ToneBadge>
        ) : (
          <ToneBadge tone="warning">Live mode</ToneBadge>
        )}
        <span className="text-xs text-muted-foreground">
          {data.dryRun
            ? "Matched rules record what they would do; nothing is posted to GitHub or run locally."
            : "Approved rules post to GitHub, start review threads, and update checkouts."}
        </span>
        {loading ? (
          <span className="ml-auto inline-flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
            <Spinner className="size-3" />
            Updating
          </span>
        ) : null}
      </div>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4" aria-label="Automation summary">
        <StatCard
          label="Repositories"
          value={`${data.enabledRepositoryCount}/${data.repositories.length}`}
          detail="automation on"
        />
        <StatCard
          label="Polling"
          value={data.poll.autoPaused ? "Paused for quota" : data.poll.enabled ? `Every ${formatPollInterval(data.poll.intervalSeconds)}` : "Paused"}
          detail={data.poll.lastFinishedAt !== null ? `last ${relativeTime(data.poll.lastFinishedAt)}` : "not polled yet"}
        />
        <StatCard
          label="GraphQL quota"
          value={data.quota.graphql !== null ? `${formatCount(data.quota.graphql.remaining)} left` : "—"}
          detail={
            quotaPercent !== null && data.quota.graphql !== null
              ? `${quotaPercent}% of ${formatCount(data.quota.graphql.limit)}${quotaTone(data.quota.graphql) === "danger" ? " · low" : ""}`
              : "read from gh on demand"
          }
        />
        <StatCard
          label="Pending approvals"
          value={data.pendingApprovals}
          detail="waiting on you"
          ariaLabel={`Open events, ${data.pendingApprovals} pending approval${data.pendingApprovals === 1 ? "" : "s"}`}
          onClick={() => go("events")}
        />
      </div>
      <nav className="overflow-x-auto rounded-xl border border-border bg-card p-1" aria-label="Automation sections">
        <div className="flex min-w-max gap-1">
          {AUTOMATION_PAGES.map((id) => (
            <button
              key={id}
              type="button"
              aria-current={page === id ? "page" : undefined}
              onClick={() => go(id)}
              className={cn(
                "flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                page === id ? "bg-secondary text-foreground shadow-sm" : "text-muted-foreground hover:bg-accent",
              )}
            >
              {PAGE_LABELS[id]}
              {id === "events" && data.pendingApprovals > 0 ? (
                <span className="flex size-4 items-center justify-center rounded-full bg-amber-600 text-[10px] font-bold text-white dark:bg-amber-500 dark:text-black">
                  {data.pendingApprovals}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      </nav>
      {page === "setup" ? <SetupPage data={data} status={status} go={go} onChanged={refetch} /> : null}
      {page === "rules" ? (
        <RulesPage key={data.rules.map((rule) => rule.id).join(",")} rules={data.rules} repositories={data.repositories} onChanged={refetch} />
      ) : null}
      {page === "events" ? <EventsPage jobs={data.jobs} onChanged={refetch} /> : null}
      {page === "audit" ? <AuditPage audit={data.audit} /> : null}
      {page === "polling" ? (
        <PollingPage poll={data.poll} quota={data.quota} enabledRepositoryCount={data.enabledRepositoryCount} onChanged={refetch} />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Setup + repositories
// ---------------------------------------------------------------------------

function BaseBranchField({
  repository,
  busy,
  onSave,
}: {
  repository: AutomationRepository;
  busy: boolean;
  onSave: (branch: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(repository.baseBranch);
  useEffect(() => {
    setValue(repository.baseBranch);
    setEditing(false);
  }, [repository.baseBranch]);
  const cancel = () => {
    setValue(repository.baseBranch);
    setEditing(false);
  };
  if (!editing) {
    return (
      <button
        type="button"
        disabled={busy}
        aria-label={`Change base branch for ${repository.repo}`}
        title="Base branch: pushes to it raise push.base and checkout.update fast-forwards it"
        onClick={() => setEditing(true)}
        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
      >
        <span>Base</span>
        <span className="font-mono text-foreground">{repository.baseBranch}</span>
      </button>
    );
  }
  return (
    <form
      className="flex items-center gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        const next = value.trim();
        if (next.length === 0) return;
        if (next === repository.baseBranch) {
          setEditing(false);
          return;
        }
        onSave(next);
      }}
    >
      <Input
        className="h-8 w-36 font-mono text-xs"
        value={value}
        autoFocus
        disabled={busy}
        aria-label={`Base branch for ${repository.repo}`}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") cancel();
        }}
      />
      <Button type="submit" size="sm" className="h-8" disabled={busy || value.trim().length === 0}>
        Save
      </Button>
      <Button type="button" size="sm" variant="ghost" className="h-8" disabled={busy} onClick={cancel}>
        Cancel
      </Button>
    </form>
  );
}

function RepositoryRow({ repository, onChanged }: { repository: AutomationRepository; onChanged: () => Promise<void> }) {
  const rpc = useRpc<typeof githubRpcContract>();
  const [busy, setBusy] = useState(false);
  const update = async (input: { enabled?: boolean; baseBranch?: string }, success: string) => {
    setBusy(true);
    try {
      await rpc.call("automationSetRepository", { repo: repository.repo, ...input });
      toast.success(success);
      await onChanged();
    } catch (reason) {
      toast.error(errorText(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="flex flex-col gap-3 px-4 py-3 transition-colors hover:bg-accent/50 @[48rem]:flex-row @[48rem]:items-center">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={cn("size-2 shrink-0 rounded-full", repository.enabled ? "bg-green-500" : "bg-muted-foreground/50")}
            title={repository.enabled ? "Automation on" : "Automation off"}
            aria-hidden="true"
          />
          <span className="min-w-0 truncate text-sm font-medium text-foreground">{repository.repo}</span>
        </div>
        <p className="mt-1 truncate text-xs text-muted-foreground" title={repository.checkoutPath ?? undefined}>
          {repository.enabled ? "Polling for pull-request events" : "Automation off"}
          {" · "}
          {repository.projectId !== null ? "BB project" : "added manually"}
          {" · "}
          {repository.checkoutPath !== null ? "local checkout" : "no local checkout"}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-3 @[48rem]:justify-end">
        <BaseBranchField
          repository={repository}
          busy={busy}
          onSave={(baseBranch) => void update({ baseBranch }, `${repository.repo} base branch set to ${baseBranch}`)}
        />
        <div className="flex items-center gap-2">
          <span className="w-6 text-xs text-muted-foreground">{repository.enabled ? "On" : "Off"}</span>
          <Toggle
            checked={repository.enabled}
            loading={busy}
            label={`${repository.enabled ? "Disable" : "Enable"} automation for ${repository.repo}`}
            onChange={(enabled) => void update({ enabled }, `${repository.repo}: automation ${enabled ? "enabled" : "disabled"}`)}
          />
        </div>
      </div>
    </li>
  );
}

function SetupPage({
  data,
  status,
  go,
  onChanged,
}: {
  data: AutomationDashboard;
  status: GithubStatus | null;
  go: (page: AutomationPage) => void;
  onChanged: () => Promise<void>;
}) {
  const repositoryReady = data.enabledRepositoryCount > 0;
  const ghReady = status?.ghOk === true;
  const pollReady = data.poll.enabled;
  const rulesReady = data.rules.some((rule) => rule.enabled);
  const steps: Array<{
    title: string;
    description: string;
    done: boolean;
    action?: { label: string; onClick: () => void };
    hint?: string;
  }> = [
    {
      title: "Enable automation for a repository",
      description: "Every repository GitHub+ tracks is listed below. Turn automation on for the ones whose pull requests should raise events.",
      done: repositoryReady,
      hint: repositoryReady
        ? `${data.enabledRepositoryCount} of ${data.repositories.length} on`
        : "Choose below",
    },
    {
      title: "Authenticate the GitHub CLI",
      description: "Polling and GitHub actions run through the same gh login GitHub+ already uses; no tokens are stored by this plugin.",
      done: ghReady,
      hint: ghReady ? "Ready" : "Not ready",
    },
    {
      title: "Keep polling on",
      description: `gh lists pull requests every ${formatPollInterval(data.poll.intervalSeconds)}; the first poll stores a baseline so existing PRs are not replayed.`,
      done: pollReady,
      action: { label: "Polling settings", onClick: () => go("polling") },
    },
    {
      title: "Enable a rule",
      description: "Rules decide which events match and which approval-gated actions run.",
      done: rulesReady,
      action: { label: rulesReady ? "Review rules" : "Create a rule", onClick: () => go("rules") },
    },
  ];
  const completed = steps.filter((step) => step.done).length;
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-foreground">
              Setup progress: {completed} of {steps.length}
            </h3>
            <p className="mt-0.5 text-xs text-muted-foreground">Complete the steps in order; GitHub+ stays usable throughout.</p>
          </div>
          {completed === steps.length ? <ToneBadge tone="success">Ready</ToneBadge> : <ToneBadge tone="info">{Math.round((completed / steps.length) * 100)}%</ToneBadge>}
        </div>
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-input" role="progressbar" aria-valuenow={completed} aria-valuemin={0} aria-valuemax={steps.length} aria-label="Setup progress">
          <div className="h-full rounded-full bg-green-600 transition-all dark:bg-green-500" style={{ width: `${(completed / steps.length) * 100}%` }} />
        </div>
      </div>
      <ol className="flex flex-col gap-2">
        {steps.map((step, index) => (
          <li key={step.title} className={cn("flex flex-col gap-3 rounded-lg border bg-card p-4 sm:flex-row sm:items-start sm:justify-between", step.done ? "border-green-600/25" : "border-border")}>
            <div className="flex min-w-0 gap-3">
              <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold", step.done ? "bg-green-600 text-white dark:bg-green-500 dark:text-black" : "bg-input text-muted-foreground")} aria-hidden="true">
                {step.done ? "✓" : index + 1}
              </span>
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">{step.title}</p>
                <p className="mt-0.5 text-sm text-muted-foreground">{step.description}</p>
              </div>
            </div>
            {step.action !== undefined ? (
              <Button size="sm" variant={step.done ? "outline" : "default"} className="shrink-0 self-start" onClick={step.action.onClick}>
                {step.action.label}
              </Button>
            ) : step.hint !== undefined ? (
              <ToneBadge tone={step.done ? "success" : "default"} className="shrink-0 self-start">
                {step.hint}
              </ToneBadge>
            ) : null}
          </li>
        ))}
      </ol>
      <section className="@container overflow-hidden rounded-xl border border-border bg-card">
        <div className="border-b border-border bg-muted/50 px-4 py-2.5">
          <SectionHeader title="Repositories" description="Only repositories turned on here are polled. The base branch raises push events and is what checkout updates fast-forward." />
        </div>
        {data.repositories.length === 0 ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">No repositories are tracked yet. Attach a BB project with a GitHub origin or add one from the repositories drawer.</p>
        ) : (
          <ul className="divide-y divide-border">
            {data.repositories.map((repository) => (
              <RepositoryRow key={repository.repo} repository={repository} onChanged={onChanged} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

function blankRule(order: number): AutomationRule {
  return {
    id: `rule-${uid()}`,
    name: "New rule",
    enabled: false,
    order,
    events: ["pr.opened"],
    repos: [],
    filters: {},
    conditionGroups: [],
    actions: ["bb.review"],
    actionParameters: {},
    approvalRequired: true,
  };
}

function RuleEditor({
  rule,
  repositories,
  onChange,
}: {
  rule: AutomationRule;
  repositories: AutomationRepository[];
  onChange: (patch: Partial<AutomationRule>) => void;
}) {
  const groups = rule.conditionGroups ?? [];
  const parameters = rule.actionParameters ?? {};
  const updateGroup = (groupId: string, update: (group: AutomationRule["conditionGroups"][number]) => void) =>
    onChange({
      conditionGroups: groups.map((group) => {
        if (group.id !== groupId) return group;
        const next = { ...group, conditions: [...group.conditions] };
        update(next);
        return next;
      }),
    });
  const usedParameters = new Set(rule.actions.map((action) => ACTION_LABELS[action].parameter));
  const setParameter = (key: keyof AutomationRule["actionParameters"], value: string) =>
    onChange({ actionParameters: { ...parameters, [key]: value.length > 0 ? value : undefined } });
  const moveAction = (index: number, offset: number) => {
    const actions = [...rule.actions];
    const target = index + offset;
    if (target < 0 || target >= actions.length) return;
    [actions[index], actions[target]] = [actions[target]!, actions[index]!];
    onChange({ actions });
  };

  return (
    <div className="flex flex-col gap-4 border-t border-border px-4 py-4">
      <section className="flex flex-col gap-1.5">
        <label className="text-xs font-semibold text-muted-foreground" htmlFor={`rule-name-${rule.id}`}>
          Name
        </label>
        <Input id={`rule-name-${rule.id}`} className="h-8 max-w-md text-sm" value={rule.name} onChange={(event) => onChange({ name: event.target.value })} />
      </section>
      <section className="flex flex-col gap-1.5">
        <h4 className="text-xs font-semibold text-muted-foreground">Triggers</h4>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Trigger events">
          {EVENT_KINDS.map((kind) => (
            <Chip
              key={kind}
              label={EVENT_LABELS[kind].label}
              ariaLabel={`${EVENT_LABELS[kind].label}: ${EVENT_LABELS[kind].description}`}
              selected={rule.events.includes(kind)}
              onToggle={() => onChange({ events: rule.events.includes(kind) ? rule.events.filter((event) => event !== kind) : [...rule.events, kind] })}
            />
          ))}
        </div>
      </section>
      {repositories.length > 0 ? (
        <section className="flex flex-col gap-1.5">
          <h4 className="text-xs font-semibold text-muted-foreground">
            Repositories <span className="font-normal">(none selected = every enabled repository)</span>
          </h4>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Repositories">
            {repositories.map((repository) => {
              const selected = rule.repos.includes(repository.repo);
              return (
                <Chip
                  key={repository.repo}
                  label={repository.repo}
                  selected={selected}
                  onToggle={() => onChange({ repos: selected ? rule.repos.filter((repo) => repo !== repository.repo) : [...rule.repos, repository.repo] })}
                />
              );
            })}
          </div>
        </section>
      ) : null}
      <section className="flex flex-col gap-1.5">
        <h4 className="text-xs font-semibold text-muted-foreground">
          Condition groups <span className="font-normal">(every group must match)</span>
        </h4>
        {groups.map((group) => (
          <div key={group.id} className="flex flex-col gap-2 rounded-md border border-border bg-secondary/40 p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex gap-1" role="group" aria-label="Group combinator">
                {(["and", "or"] as const).map((combinator) => (
                  <Chip
                    key={combinator}
                    label={combinator === "and" ? "All rows" : "Any row"}
                    selected={group.combinator === combinator}
                    onToggle={() => updateGroup(group.id, (next) => { next.combinator = combinator; })}
                  />
                ))}
              </div>
              <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground" onClick={() => onChange({ conditionGroups: groups.filter((candidate) => candidate.id !== group.id) })}>
                Remove group
              </Button>
            </div>
            {group.conditions.map((condition: RuleCondition) => (
              <div key={condition.id} className="grid grid-cols-[1fr_auto_1.4fr_auto] items-center gap-1.5">
                <select
                  className={selectClass}
                  value={condition.field}
                  aria-label="Condition field"
                  onChange={(event) =>
                    updateGroup(group.id, (next) => {
                      next.conditions = next.conditions.map((candidate) => candidate.id === condition.id ? { ...candidate, field: event.target.value as RuleCondition["field"] } : candidate);
                    })
                  }
                >
                  {CONDITION_FIELDS.map((field) => (
                    <option key={field} value={field}>{CONDITION_FIELD_LABELS[field].label}</option>
                  ))}
                </select>
                <select
                  className={selectClass}
                  value={condition.operator}
                  aria-label="Condition operator"
                  onChange={(event) =>
                    updateGroup(group.id, (next) => {
                      next.conditions = next.conditions.map((candidate) => candidate.id === condition.id ? { ...candidate, operator: event.target.value as RuleCondition["operator"] } : candidate);
                    })
                  }
                >
                  {CONDITION_OPERATORS.map((operator) => (
                    <option key={operator} value={operator}>{OPERATOR_LABELS[operator]}</option>
                  ))}
                </select>
                <Input
                  className="h-8 font-mono text-xs"
                  value={condition.value}
                  placeholder={CONDITION_FIELD_LABELS[condition.field].placeholder}
                  aria-label="Condition value"
                  onChange={(event) =>
                    updateGroup(group.id, (next) => {
                      next.conditions = next.conditions.map((candidate) => candidate.id === condition.id ? { ...candidate, value: event.target.value } : candidate);
                    })
                  }
                />
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs text-muted-foreground"
                  aria-label="Remove condition"
                  onClick={() =>
                    updateGroup(group.id, (next) => {
                      next.conditions = next.conditions.filter((candidate) => candidate.id !== condition.id);
                    })
                  }
                >
                  ×
                </Button>
              </div>
            ))}
            <Button
              variant="outline"
              size="sm"
              className="h-7 self-start text-xs"
              onClick={() =>
                updateGroup(group.id, (next) => {
                  next.conditions = [...next.conditions, { id: uid(), field: "base", operator: "equals", value: "main" }];
                })
              }
            >
              Add row
            </Button>
          </div>
        ))}
        <Button variant="outline" size="sm" className="h-7 self-start text-xs" onClick={() => onChange({ conditionGroups: [...groups, { id: uid(), combinator: "and", conditions: [] }] })}>
          Add condition group
        </Button>
      </section>
      <section className="flex flex-col gap-1.5">
        <h4 className="text-xs font-semibold text-muted-foreground">
          Actions <span className="font-normal">(run in order)</span>
        </h4>
        {rule.actions.length > 0 ? (
          <ol className="flex flex-col gap-1">
            {rule.actions.map((action, index) => (
              <li key={`${action}-${index}`} className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5">
                <span className="w-4 text-center text-xs text-muted-foreground">{index + 1}</span>
                <span className="min-w-0 flex-1 truncate text-sm" title={ACTION_LABELS[action].description}>{ACTION_LABELS[action].label}</span>
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" disabled={index === 0} aria-label={`Move ${ACTION_LABELS[action].label} earlier`} onClick={() => moveAction(index, -1)}>
                  ↑
                </Button>
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" disabled={index === rule.actions.length - 1} aria-label={`Move ${ACTION_LABELS[action].label} later`} onClick={() => moveAction(index, 1)}>
                  ↓
                </Button>
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground" aria-label={`Remove ${ACTION_LABELS[action].label}`} onClick={() => onChange({ actions: rule.actions.filter((_, candidate) => candidate !== index) })}>
                  ×
                </Button>
              </li>
            ))}
          </ol>
        ) : null}
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Add action">
          {ACTION_KINDS.filter((action) => !rule.actions.includes(action)).map((action) => (
            <Chip key={action} label={ACTION_LABELS[action].label} ariaLabel={`Add action: ${ACTION_LABELS[action].description}`} selected={false} onToggle={() => onChange({ actions: [...rule.actions, action] })} />
          ))}
        </div>
        {usedParameters.has("targetBranch") ? (
          <Input className="h-8 max-w-64 font-mono text-xs" value={parameters.targetBranch ?? ""} placeholder="Target branch (repository base when blank)" aria-label="Target branch" onChange={(event) => setParameter("targetBranch", event.target.value)} />
        ) : null}
        {usedParameters.has("label") ? (
          <Input className="h-8 max-w-64 font-mono text-xs" value={parameters.label ?? ""} placeholder="Label (bb-automation when blank)" aria-label="Label" onChange={(event) => setParameter("label", event.target.value)} />
        ) : null}
        {usedParameters.has("reviewPrompt") ? (
          <Textarea className="min-h-16 text-xs" rows={2} value={parameters.reviewPrompt ?? ""} placeholder="Extra review instructions for the agent (optional)" aria-label="Review prompt" onChange={(event) => setParameter("reviewPrompt", event.target.value)} />
        ) : null}
        {usedParameters.has("bodyTemplate") ? (
          <Textarea className="min-h-16 text-xs" rows={2} value={parameters.bodyTemplate ?? ""} placeholder={`Body template: ${TEMPLATE_PLACEHOLDERS.slice(0, 5).join(", ")}…`} aria-label="Body template" onChange={(event) => setParameter("bodyTemplate", event.target.value)} />
        ) : null}
      </section>
      <div className="flex items-center gap-2">
        <Toggle checked={rule.approvalRequired} onChange={(approvalRequired) => onChange({ approvalRequired })} label={`Require approval for ${rule.name}`} />
        <span className="text-xs text-muted-foreground">Require approval before actions run</span>
      </div>
    </div>
  );
}

function RulesPage({
  rules: savedRules,
  repositories,
  onChanged,
}: {
  rules: AutomationRule[];
  repositories: AutomationRepository[];
  onChanged: () => Promise<void>;
}) {
  const rpc = useRpc<typeof githubRpcContract>();
  const [rules, setRules] = useState<AutomationRule[]>(savedRules);
  const [baseline, setBaseline] = useState(savedRules);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [jsonMode, setJsonMode] = useState(false);
  const [jsonText, setJsonText] = useState("");
  const [saving, setSaving] = useState(false);
  const dirty = useMemo(() => JSON.stringify(rules) !== JSON.stringify(baseline), [rules, baseline]);
  const updateRule = (id: string, patch: Partial<AutomationRule>) =>
    setRules((current) => current.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)));
  const nextOrder = () => (rules.length === 0 ? 0 : Math.max(...rules.map((rule) => rule.order))) + 10;
  const addBlank = () => {
    const rule = blankRule(nextOrder());
    setRules((current) => [...current, rule]);
    setExpandedId(rule.id);
  };
  const addTemplate = (template: AutomationRule) => {
    const rule: AutomationRule = { ...structuredClone(template), id: `rule-${uid()}`, order: nextOrder() };
    setRules((current) => [...current, rule]);
    setExpandedId(rule.id);
  };
  const save = () => {
    setSaving(true);
    void (async () => {
      try {
        const toSave = jsonMode ? (JSON.parse(jsonText) as AutomationRule[]) : rules;
        const result = await rpc.call("automationSaveRules", { rules: toSave });
        toast.success(`${result.saved} rule${result.saved === 1 ? "" : "s"} saved`);
        setBaseline(toSave);
        setRules(toSave);
        await onChanged();
      } catch (reason) {
        toast.error(errorText(reason));
      } finally {
        setSaving(false);
      }
    })();
  };
  const sorted = [...rules].sort((a, b) => a.order - b.order);
  return (
    <div className="flex flex-col gap-4" aria-busy={saving || undefined}>
      <SectionHeader
        title="Rules"
        description="Matched in order against every polled event. Approval-gated rules pause jobs until you approve them on the Events page."
        action={
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              aria-pressed={jsonMode}
              onClick={() => {
                if (!jsonMode) setJsonText(JSON.stringify(rules, null, 2));
                setJsonMode(!jsonMode);
              }}
            >
              {jsonMode ? "Builder" : "JSON"}
            </Button>
            <Button size="sm" onClick={addBlank}>
              New rule
            </Button>
          </div>
        }
      />
      {dirty ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-600/30 bg-amber-600/5 px-4 py-2.5 dark:bg-amber-500/10">
          <p className="text-xs text-amber-700 dark:text-amber-400">Unsaved changes</p>
          <div className="flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={saving}
              className="h-7 text-xs"
              onClick={() => {
                setRules(baseline);
                setJsonText(JSON.stringify(baseline, null, 2));
              }}
            >
              Discard
            </Button>
            <Button size="sm" className="h-7 text-xs" disabled={saving} aria-busy={saving} onClick={save}>
              {saving ? "Saving…" : "Save rules"}
            </Button>
          </div>
        </div>
      ) : null}
      {jsonMode ? (
        <Textarea className="min-h-96 font-mono text-xs" value={jsonText} aria-label="Rules as JSON" onChange={(event) => setJsonText(event.target.value)} />
      ) : sorted.length === 0 ? (
        <EmptyState title="No rules yet" message="Create a rule, or start from a template below." actionLabel="Create a rule" onAction={addBlank} />
      ) : (
        <ul className="flex flex-col gap-2">
          {sorted.map((rule) => {
            const expanded = expandedId === rule.id;
            return (
              <li key={rule.id} className="overflow-hidden rounded-lg border border-border bg-card">
                <div className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    aria-expanded={expanded}
                    onClick={() => setExpandedId(expanded ? null : rule.id)}
                  >
                    <span className="shrink-0 text-xs text-muted-foreground" aria-hidden="true">{expanded ? "▾" : "▸"}</span>
                    <div className="min-w-0 flex-1">
                      <p className={cn("truncate text-sm font-medium", rule.enabled ? "text-foreground" : "text-muted-foreground")}>{rule.name}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {rule.events.map((event) => EVENT_LABELS[event].label).join(", ")} · {rule.actions.length} action{rule.actions.length === 1 ? "" : "s"}
                        {rule.repos.length > 0 ? ` · ${rule.repos.join(", ")}` : ""}
                        {(rule.conditionGroups ?? []).length > 0 ? ` · ${rule.conditionGroups.length} condition group${rule.conditionGroups.length === 1 ? "" : "s"}` : ""}
                      </p>
                    </div>
                  </button>
                  {rule.approvalRequired ? <ToneBadge tone="warning">Approval</ToneBadge> : null}
                  <Toggle checked={rule.enabled} onChange={(enabled) => updateRule(rule.id, { enabled })} label={`${rule.enabled ? "Disable" : "Enable"} ${rule.name}`} />
                  <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-red-500" aria-label={`Delete ${rule.name}`} onClick={() => setRules((current) => current.filter((candidate) => candidate.id !== rule.id))}>
                    Delete
                  </Button>
                </div>
                {expanded ? <RuleEditor rule={rule} repositories={repositories} onChange={(patch) => updateRule(rule.id, patch)} /> : null}
              </li>
            );
          })}
        </ul>
      )}
      <section className="flex flex-col gap-2">
        <h4 className="text-xs font-semibold text-muted-foreground">Starter templates</h4>
        <div className="grid gap-2 sm:grid-cols-3">
          {STARTER_RULES.map((template) => (
            <button
              key={template.id}
              type="button"
              onClick={() => addTemplate(template)}
              className="flex cursor-pointer flex-col gap-1 rounded-lg border border-border bg-card p-3 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <span className="text-sm font-medium text-foreground">{template.name}</span>
              <span className="text-xs text-muted-foreground">
                {template.events.map((event) => EVENT_LABELS[event].label).join(", ")} → {template.actions.map((action) => ACTION_LABELS[action].label).join(", ")}
              </span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Events (jobs) + audit
// ---------------------------------------------------------------------------

function jobTitle(job: JobRecord): string {
  const subject = job.prNumber !== null ? `${job.repo}#${job.prNumber}` : job.repo;
  return `${EVENT_LABELS[job.kind]?.label ?? job.kind} · ${subject}`;
}

function EventsPage({ jobs, onChanged }: { jobs: JobRecord[]; onChanged: () => Promise<void> }) {
  const rpc = useRpc<typeof githubRpcContract>();
  const [busyId, setBusyId] = useState<number | null>(null);
  const [reconciling, setReconciling] = useState(false);
  const replay = async (job: JobRecord, approve: boolean) => {
    setBusyId(job.id);
    try {
      const result = await rpc.call("automationReplayJob", { jobId: job.id, approve });
      if (result.queued) toast.success(approve ? `Job ${job.id} approved and queued` : `Job ${job.id} requeued`);
      else toast.error(`Job ${job.id} could not be requeued.`);
      await onChanged();
    } catch (reason) {
      toast.error(errorText(reason));
    } finally {
      setBusyId(null);
    }
  };
  const reconcile = async () => {
    setReconciling(true);
    try {
      const result = await rpc.call("automationReconcile");
      toast.success(`${result.queued} stale job${result.queued === 1 ? "" : "s"} requeued`);
      await onChanged();
    } catch (reason) {
      toast.error(errorText(reason));
    } finally {
      setReconciling(false);
    }
  };
  return (
    <div className="flex flex-col gap-3">
      <SectionHeader
        title="Events, approvals and dead letters"
        description="Newest first. Approval-gated rules wait here until you approve them; failed jobs retry three times before landing in the dead-letter state."
        action={
          <Button variant="ghost" size="sm" disabled={reconciling} aria-busy={reconciling} onClick={() => void reconcile()}>
            Requeue stale running jobs
          </Button>
        }
      />
      {jobs.length === 0 ? (
        <EmptyState
          title="No events yet"
          message="When polling detects a pull-request transition on an enabled repository, the job and its rule runs appear here, including anything waiting on your approval."
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {jobs.map((job) => {
            const meta = JOB_STATUS_LABELS[job.status];
            const replayable = job.status === "dead_letter" || job.status === "succeeded" || job.status === "skipped";
            return (
              <li
                key={job.id}
                className={cn(
                  "flex flex-col gap-3 rounded-lg border bg-card px-4 py-3",
                  job.status === "pending_approval" ? "border-amber-600/40" : job.status === "dead_letter" ? "border-red-500/40" : "border-border",
                )}
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium text-foreground">Job {job.id}</p>
                      <ToneBadge tone={meta.tone}>{meta.label}</ToneBadge>
                      <span className="truncate text-xs text-muted-foreground">{jobTitle(job)}</span>
                    </div>
                    {job.title.length > 0 ? <p className="mt-0.5 truncate text-sm text-foreground">{job.title}</p> : null}
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {job.matchedRules.length > 0 ? `rules: ${job.matchedRules.join(", ")}` : "no rule evaluated yet"} · {job.attempts} attempt{job.attempts === 1 ? "" : "s"} · {relativeTime(job.updatedAt)}
                    </p>
                    {job.error !== null ? <p role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">{job.error}</p> : null}
                  </div>
                  {job.status === "pending_approval" ? (
                    <div className="flex shrink-0 gap-2">
                      <Button
                        size="sm"
                        disabled={busyId !== null}
                        aria-busy={busyId === job.id}
                        onClick={() => {
                          if (window.confirm(`Approve job ${job.id}? The matched rules run their actions (subject to dry-run mode).`)) void replay(job, true);
                        }}
                      >
                        {busyId === job.id ? "Running…" : "Approve and run"}
                      </Button>
                    </div>
                  ) : replayable ? (
                    <Button variant="outline" size="sm" className="shrink-0" disabled={busyId !== null} aria-busy={busyId === job.id} onClick={() => void replay(job, false)}>
                      {busyId === job.id ? "Replaying…" : "Replay"}
                    </Button>
                  ) : null}
                </div>
                {job.actions.length > 0 ? (
                  <details className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs">
                    <summary className="cursor-pointer font-medium text-foreground">
                      {job.actions.length} action run{job.actions.length === 1 ? "" : "s"}
                    </summary>
                    <ul className="mt-2 flex flex-col gap-2">
                      {job.actions.map((run) => (
                        <li key={`${run.ruleId}-${run.actionIndex}`} className="flex flex-col gap-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <ToneBadge tone={run.status === "succeeded" ? "success" : run.status === "failed" ? "danger" : "info"}>{run.status}</ToneBadge>
                            <span className="font-medium text-foreground">{ACTION_LABELS[run.actionKind]?.label ?? run.actionKind}</span>
                            <span className="text-muted-foreground">{run.ruleName}</span>
                          </div>
                          {run.output !== null && run.output.length > 0 ? (
                            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-background p-2 text-[11px] text-muted-foreground">{run.output}</pre>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

const OUTCOME_TONES: Record<string, Tone> = {
  succeeded: "success",
  ok: "success",
  baseline: "info",
  enabled: "success",
  saved: "success",
  queued: "info",
  "dry-run": "info",
  "pending-approval": "warning",
  paused: "warning",
  warning: "warning",
  error: "danger",
  dead_letter: "danger",
  skipped: "default",
  disabled: "default",
};

function AuditPage({ audit }: { audit: AuditRecord[] }) {
  if (audit.length === 0) {
    return <EmptyState title="No audit records yet" message="Every poll, rule save, job transition, and action run is appended here." />;
  }
  return (
    <div className="flex flex-col gap-3">
      <SectionHeader title="Audit trail" description="Append-only. Newest first; the newest 5,000 records are kept." />
      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
        {audit.map((record) => (
          <li key={record.id} className="flex items-start gap-3 px-4 py-2.5">
            <ToneBadge tone={OUTCOME_TONES[record.outcome] ?? "default"} className="mt-0.5 shrink-0">
              {record.outcome}
            </ToneBadge>
            <div className="min-w-0 flex-1">
              <p className="text-sm">
                <span className="font-medium text-foreground">{record.kind}</span>{" "}
                <span className="text-muted-foreground">{record.subject}</span>
              </p>
              <p className="mt-0.5 whitespace-pre-wrap break-all text-xs text-muted-foreground">{record.detail}</p>
            </div>
            <span className="shrink-0 text-xs text-muted-foreground">{relativeTime(record.createdAt)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Polling + quota
// ---------------------------------------------------------------------------

function barClass(tone: ReturnType<typeof quotaTone>): string {
  if (tone === "success") return "bg-green-600 dark:bg-green-500";
  if (tone === "warning") return "bg-amber-600 dark:bg-amber-500";
  if (tone === "danger") return "bg-destructive";
  return "bg-muted-foreground";
}

function QuotaMeter({ label, detail, bucket }: { label: string; detail: string; bucket: GithubQuotaBucket | null }) {
  const tone = quotaTone(bucket);
  const percent = Math.round(quotaFraction(bucket) * 100);
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
          <p className="mt-1 text-lg font-semibold tabular-nums text-foreground">{bucket !== null ? `${formatCount(bucket.remaining)} / ${formatCount(bucket.limit)}` : "—"}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>
        </div>
        {bucket !== null ? <ToneBadge tone={tone === "default" ? "default" : tone}>{percent}% left</ToneBadge> : <ToneBadge>Unknown</ToneBadge>}
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-input" role="progressbar" aria-label={`${label} remaining`} aria-valuemin={0} aria-valuemax={bucket?.limit ?? 0} aria-valuenow={bucket?.remaining ?? 0}>
        <div className={cn("h-full rounded-full transition-all", barClass(tone))} style={{ width: `${percent}%` }} />
      </div>
      {bucket !== null ? <p className="mt-2 text-xs text-muted-foreground">{formatCount(bucket.used)} used · resets {formatWhen(bucket.resetAt)}</p> : null}
    </div>
  );
}

function PollingPage({
  poll,
  quota,
  enabledRepositoryCount,
  onChanged,
}: {
  poll: PollStatus;
  quota: GithubQuota;
  enabledRepositoryCount: number;
  onChanged: () => Promise<void>;
}) {
  const rpc = useRpc<typeof githubRpcContract>();
  const [pauseAt, setPauseAt] = useState(String(poll.quotaPauseRemaining));
  const [busy, setBusy] = useState<"poll" | "interval" | "enabled" | "quota" | "pause" | null>(null);
  useEffect(() => setPauseAt(String(poll.quotaPauseRemaining)), [poll.quotaPauseRemaining]);
  const run = async (key: NonNullable<typeof busy>, action: () => Promise<unknown>, success?: string) => {
    setBusy(key);
    try {
      await action();
      await onChanged();
      if (success !== undefined) toast.success(success);
    } catch (reason) {
      toast.error(errorText(reason));
    } finally {
      setBusy(null);
    }
  };
  const applyInterval = (seconds: number) =>
    run("interval", () => rpc.call("automationSetPolling", { intervalSeconds: seconds }), `Polling every ${formatPollInterval(seconds)}`);
  const applyPauseAt = (remaining: number) =>
    run("pause", () => rpc.call("automationSetPolling", { quotaPauseRemaining: remaining }), remaining <= 0 ? "Auto-pause off" : `Auto-pause at ${formatCount(remaining)} GraphQL points`);
  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3">
        <SectionHeader
          title="GitHub CLI polling"
          description="Automation lists pull requests with gh for every enabled repository. No webhook or public tunnel is required."
          action={
            <Toggle
              checked={poll.enabled}
              disabled={busy !== null}
              loading={busy === "enabled"}
              label={poll.enabled ? "Pause automation polling" : "Resume automation polling"}
              onChange={(enabled) => void run("enabled", () => rpc.call("automationSetPolling", { enabled }), enabled ? "Polling resumed" : "Polling paused")}
            />
          }
        />
        <div className="grid gap-2 sm:grid-cols-3">
          <div className="rounded-lg border border-border bg-card px-3 py-2">
            <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Status</p>
            <div className="mt-1">
              {poll.inProgress ? <ToneBadge tone="info">Polling…</ToneBadge> : poll.autoPaused ? <ToneBadge tone="warning">Paused for quota</ToneBadge> : poll.enabled ? <ToneBadge tone="success">Every {formatPollInterval(poll.intervalSeconds)}</ToneBadge> : <ToneBadge>Paused</ToneBadge>}
            </div>
          </div>
          <div className="rounded-lg border border-border bg-card px-3 py-2">
            <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Last poll</p>
            <p className="mt-0.5 text-sm font-medium text-foreground">{formatWhen(poll.lastFinishedAt)}</p>
            <p className="text-xs text-muted-foreground">{poll.lastQueued} event{poll.lastQueued === 1 ? "" : "s"} queued</p>
          </div>
          <div className="rounded-lg border border-border bg-card px-3 py-2">
            <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Next poll</p>
            <p className="mt-0.5 text-sm font-medium text-foreground">{poll.autoPaused ? formatWhen(poll.resumeAt) : poll.enabled ? formatWhen(poll.nextAt) : "Paused"}</p>
          </div>
        </div>
        {poll.autoPaused ? (
          <p role="status" className="rounded-lg border border-amber-600/30 bg-amber-600/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-400">
            Polling is paused because GraphQL remaining{quota.graphql !== null ? ` (${formatCount(quota.graphql.remaining)})` : ""} is at or below {formatCount(poll.quotaPauseRemaining)}. It resumes when the quota resets {formatWhen(poll.resumeAt)}.
          </p>
        ) : null}
        {poll.lastError !== null ? (
          <p role="alert" className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-400">{poll.lastError}</p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            disabled={busy !== null || enabledRepositoryCount === 0 || poll.autoPaused || poll.inProgress}
            aria-busy={busy === "poll" || poll.inProgress}
            onClick={() =>
              void run("poll", async () => {
                const result = await rpc.call("automationPollNow");
                if (!result.ran) throw new Error(result.error ?? "Poll did not run");
                if (result.error !== null) toast.error(result.error);
              }, "Polled GitHub with gh")
            }
          >
            {busy === "poll" || poll.inProgress ? <Spinner className="mr-1.5 size-3" /> : null}
            Poll now
          </Button>
          {enabledRepositoryCount === 0 ? <span className="text-xs text-muted-foreground">Enable a repository on the Setup page to start polling.</span> : null}
        </div>
      </section>
      <section className="flex flex-col gap-3">
        <SectionHeader
          title="GitHub API quota"
          description="Read live from gh. GraphQL is what polling spends; REST is a separate bucket used for ref lookups."
          action={
            <Button variant="ghost" size="sm" disabled={busy !== null} aria-busy={busy === "quota"} onClick={() => void run("quota", () => rpc.call("automationQuota", { force: true }), "Quota refreshed")} aria-label="Refresh GitHub API quota">
              Refresh quota
            </Button>
          }
        />
        {quota.error !== null && quota.graphql === null ? (
          <p role="alert" className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-400">{quota.error}</p>
        ) : null}
        <div className="grid gap-2 sm:grid-cols-2">
          <QuotaMeter label="GraphQL points" detail={quota.graphql !== null ? `Points per hour for gh pr list and other GraphQL calls${quota.login !== null ? ` · ${quota.login}` : ""}` : "gh pr list spends this GraphQL budget."} bucket={quota.graphql} />
          <QuotaMeter label="REST requests" detail="REST requests such as the base-branch SHA check." bucket={quota.rest} />
        </div>
        <p className="text-xs text-muted-foreground">
          {quota.checkedAt !== null
            ? `Checked ${relativeTime(quota.checkedAt)}. This quota is shared with every other gh command on this machine, including GitHub+ sync.`
            : "Quota has not been read yet."}
        </p>
      </section>
      <section className="flex flex-col gap-3">
        <SectionHeader title="Poll interval" description={`gh runs every ${formatPollInterval(poll.intervalSeconds)} for each enabled repository.`} />
        <div className="flex flex-wrap gap-2">
          {POLL_INTERVAL_PRESETS.map((seconds) => (
            <Button key={seconds} size="sm" variant={poll.intervalSeconds === seconds ? "default" : "outline"} disabled={busy !== null} onClick={() => void applyInterval(seconds)}>
              {formatPollInterval(seconds)}
            </Button>
          ))}
        </div>
      </section>
      <section className="flex flex-col gap-3">
        <SectionHeader title="Auto-pause for quota" description="Stop scheduled polling when GraphQL points remaining reach this floor. Polling resumes after GitHub resets the hourly quota. Off disables the guard." />
        <div className="flex flex-wrap gap-2">
          {QUOTA_PAUSE_PRESETS.map((remaining) => (
            <Button key={remaining} size="sm" variant={poll.quotaPauseRemaining === remaining ? "default" : "outline"} disabled={busy !== null} onClick={() => void applyPauseAt(remaining)}>
              {remaining === 0 ? "Off" : formatCount(remaining)}
            </Button>
          ))}
        </div>
        <form
          className="flex max-w-md items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const remaining = Number(pauseAt);
            if (!Number.isInteger(remaining) || remaining < QUOTA_PAUSE_MIN || remaining > QUOTA_PAUSE_MAX) {
              toast.error(`Enter a whole number from ${QUOTA_PAUSE_MIN} to ${QUOTA_PAUSE_MAX}.`);
              return;
            }
            void applyPauseAt(remaining);
          }}
        >
          <label className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Pause at remaining GraphQL points</span>
            <Input type="number" min={QUOTA_PAUSE_MIN} max={QUOTA_PAUSE_MAX} step={1} value={pauseAt} onChange={(event) => setPauseAt(event.target.value)} aria-label="Pause polling at remaining GraphQL points" />
          </label>
          <Button type="submit" size="sm" variant="outline" disabled={busy !== null} aria-busy={busy === "pause"}>
            Save threshold
          </Button>
        </form>
      </section>
      <section className="flex flex-col gap-3">
        <SectionHeader title="Repositories" description="Each enabled repository is polled with gh." />
        {poll.repositories.length === 0 ? (
          <EmptyState title="No repositories enabled" message="Turn automation on for a repository on the Setup page." />
        ) : (
          <ul className="flex flex-col gap-2">
            {poll.repositories.map((repository) => (
              <li key={repository.repo} className="rounded-lg border border-border bg-card px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">{repository.repo}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {repository.lastPolledAt !== null ? `Last polled ${relativeTime(repository.lastPolledAt)}` : "Not polled yet"}
                      {repository.lastQueued > 0 ? ` · ${repository.lastQueued} queued` : ""}
                    </p>
                    {repository.lastError !== null ? <p role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">{repository.lastError}</p> : null}
                  </div>
                  <ToneBadge tone={repository.lastError !== null ? "danger" : repository.lastPolledAt !== null ? "success" : "default"}>
                    {repository.lastError !== null ? "Error" : repository.lastPolledAt !== null ? "Watching" : "Waiting"}
                  </ToneBadge>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chat result card: ::github-automation{status title repository page}
// ---------------------------------------------------------------------------

function directiveText(value: string | undefined, fallback: string, max = 160): string {
  const normalized = value?.trim().replace(/\s+/g, " ");
  return normalized !== undefined && normalized.length > 0 ? normalized.slice(0, max) : fallback;
}

const DIRECTIVE_ACCENT: Record<"success" | "warning" | "error" | "info", string> = {
  success: "bg-green-600 dark:bg-green-500",
  warning: "bg-amber-600 dark:bg-amber-500",
  error: "bg-destructive",
  info: "bg-foreground/40",
};

export function AutomationDirective({ attributes }: PluginMessageDirectiveProps) {
  const navigate = useBbNavigate();
  const rawStatus = attributes.status?.trim();
  const status = rawStatus === "success" || rawStatus === "warning" || rawStatus === "error" ? rawStatus : "info";
  const title = directiveText(attributes.title, "GitHub+ automation");
  const repository = directiveText(attributes.repository, "");
  const detail = directiveText(attributes.detail, "Open the GitHub+ Automation tab for the latest state.", 240);
  const rulesPage = attributes.page?.trim() === "rules";
  const tone: Tone = status === "error" ? "danger" : status;
  const statusLabel = status === "success" ? "Created" : status === "warning" ? "Needs attention" : status === "error" ? "Failed" : "Info";
  return (
    <div role={status === "error" ? "alert" : "status"} className="my-4 w-full max-w-2xl overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-sm">
      <div className={cn("h-1", DIRECTIVE_ACCENT[status])} aria-hidden="true" />
      <div className="p-4 sm:p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 pt-0.5">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">GitHub+ automation</p>
            <h3 className="mt-1 break-words text-sm font-semibold tracking-tight text-foreground">{title}</h3>
          </div>
          <ToneBadge tone={tone} className="mt-0.5 shrink-0">{statusLabel}</ToneBadge>
        </div>
        <p className="mt-4 text-sm leading-6 text-muted-foreground">{detail}</p>
        {repository.length > 0 ? (
          <div className="mt-4 flex min-w-0 items-center gap-3 rounded-lg border border-border bg-secondary/40 px-3 py-2.5">
            <div className="min-w-0">
              <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Repository</p>
              <p className="truncate font-mono text-xs font-medium text-foreground">{repository}</p>
            </div>
          </div>
        ) : null}
        <div className="mt-4 flex flex-col-reverse items-stretch gap-3 border-t border-border pt-3 sm:flex-row sm:items-center sm:justify-between">
          <span className="text-xs text-muted-foreground">Manage in the GitHub+ panel</span>
          <Button size="sm" className="w-full shrink-0 sm:w-auto" onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath: rulesPage ? "automation/rules" : "automation" })}>
            {rulesPage ? "Open rules" : "Open automation"}
          </Button>
        </div>
      </div>
    </div>
  );
}
