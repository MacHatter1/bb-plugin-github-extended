import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  definePluginApp,
  experimental_Diff as Diff,
  useBbNavigate,
  useRealtime,
  useRpc,
  type PluginNavPanelProps,
  type PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import {
  buildSuggestions,
  isSafeExternalUrl,
  matchesQuery,
  normalizeStatus,
  parseQuery,
  parseSubPath,
  repoHealthColorCounts,
  repoHealthDotClass,
  routeToSubPath,
  summarizeRepoHealth,
  type GithubStatus,
  type Item,
  type RepoHealth,
  type RepoInfo,
  type RepoStatus,
  type Route,
  type Suggestion,
  type SuggestionIcon,
} from "./app-logic.js";
import type {
  DependabotAlert,
  DependabotAlertDetail,
  githubRpcContract,
} from "./server.js";
import {
  LEGACY_QUERY_KEY,
  QUERY_STATE_KEY,
  SAVED_VIEWS_KEY,
  deleteSavedView,
  loadQueryState,
  loadSavedViews,
  saveQueryState,
  saveSavedViews,
  upsertSavedView,
  type QueryState,
  type SavedViewTab,
  type SavedViews,
} from "./saved-views.js";
import "../styles.css";
import "./ui-fixes.css";
import { toast } from "sonner";
import { Badge } from "./shared-ui.js";
import { Button } from "./shared-ui.js";
import { cn } from "./shared-ui.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./shared-ui.js";
import { Input } from "./shared-ui.js";
import { MenuLoading } from "./shared-ui.js";
import { RefreshBar } from "./shared-ui.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./shared-ui.js";
import { Skeleton } from "./shared-ui.js";
import { Spinner } from "./shared-ui.js";
import { Tabs, TabsList, TabsPanel, TabsTrigger } from "./shared-ui.js";
import { Textarea } from "./shared-ui.js";
import { EmptyState } from "@/components/empty-state";
import { Markdown, SafeUrlLink } from "@/components/markdown-lite";

interface IssueComment {
  author: string;
  body: string;
  createdAt: string;
}

interface IssueDetail extends Omit<Item, "kind"> {
  comments: IssueComment[];
}

interface PullCheck {
  name: string;
  status: "success" | "failure" | "pending" | "neutral";
  url: string;
}

interface PullReview {
  author: string;
  state: string;
  body: string;
  createdAt: string;
}

interface ReviewThread {
  path: string;
  line: number | null;
  diffHunk: string;
  comments: IssueComment[];
}

interface PullFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string | null;
}

interface PullDetail {
  repo: string;
  number: number;
  title: string;
  state: string;
  author: string;
  body: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  baseRefName: string;
  headRefName: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  labels: string[];
  assignees: string[];
  reviewDecision: string;
  mergeStateStatus: string;
  reviewRequests: string[];
  checks: PullCheck[];
  comments: IssueComment[];
  reviews: PullReview[];
  reviewThreads: ReviewThread[];
  files: PullFile[];
}

interface ThreadLink {
  kind: "issue" | "pr";
  repo: string;
  number: number;
  threadId: string;
  createdAt: string;
}

type LinksMap = Record<string, ThreadLink[]>;

function asItems(result: unknown): Item[] {
  const items = (result as { items?: unknown })?.items;
  return Array.isArray(items) ? (items as Item[]) : [];
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, (Date.now() - then) / 1000);
  if (seconds < 3600) return `${Math.max(1, Math.floor(seconds / 60))}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

const PANEL_PATH = "github";

function useSubPathRoute(subPath: string): [Route, (route: Route) => void] {
  const bbNavigate = useBbNavigate();
  const route = useMemo(() => parseSubPath(subPath), [subPath]);
  const navigate = useCallback(
    (next: Route) => {
      bbNavigate.toPluginPanel(PANEL_PATH, { subPath: routeToSubPath(next) });
    },
    [bbNavigate],
  );
  return [route, navigate];
}

function useItems(kind: "issue" | "pr"): {
  items: Item[] | null;
  error: string | null;
  loading: boolean;
  refetch: () => void;
} {
  const rpc = useRpc<typeof githubRpcContract>();
  const requestRef = useRef(0);
  const activeKind = useRef(kind);
  activeKind.current = kind;
  const [state, setState] = useState<{
    items: Item[] | null;
    error: string | null;
    loading: boolean;
    kind: "issue" | "pr";
  }>({
    items: null,
    error: null,
    loading: true,
    kind,
  });
  const refetch = useCallback(() => {
    const requestId = ++requestRef.current;
    const requestKind = kind;
    setState((previous) => ({
      items: previous.kind === requestKind ? previous.items : null,
      error: previous.kind === requestKind ? previous.error : null,
      loading: true,
      kind: requestKind,
    }));
    rpc.call("listItems", { kind }).then(
      (result) => {
        if (requestId !== requestRef.current || requestKind !== activeKind.current) return;
        setState({
          items: asItems(result),
          error: null,
          loading: false,
          kind: requestKind,
        });
      },
      (error: unknown) => {
        if (requestId !== requestRef.current || requestKind !== activeKind.current) return;
        setState((previous) => ({
          items: previous.kind === requestKind ? previous.items : null,
          error: errorText(error),
          loading: false,
          kind: requestKind,
        }));
      },
    );
  }, [rpc, kind]);
  useEffect(() => {
    refetch();
    return () => {
      requestRef.current += 1;
    };
  }, [refetch]);
  useRealtime("data-changed", refetch);
  return { ...state, refetch };
}

function useLinks(): {
  links: LinksMap;
  error: string | null;
  refetch: () => void;
} {
  const rpc = useRpc<typeof githubRpcContract>();
  const requestRef = useRef(0);
  const [links, setLinks] = useState<LinksMap>({});
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    const requestId = ++requestRef.current;
    setError(null);
    rpc.call("listLinks").then(
      (result) => {
        if (requestId !== requestRef.current) return;
        const map = (result as { links?: unknown })?.links;
        if (map !== null && typeof map === "object") {
          setLinks(map as LinksMap);
        } else {
          setLinks({});
          setError("malformed link response");
        }
      },
      (reason: unknown) => {
        if (requestId !== requestRef.current) return;
        setLinks({});
        setError(errorText(reason));
      },
    );
  }, [rpc]);
  useEffect(() => {
    refetch();
    return () => {
      requestRef.current += 1;
    };
  }, [refetch]);
  useRealtime("links-changed", refetch);
  return { links, error, refetch };
}

function LinkErrorNotice({
  error,
  onRetry,
}: {
  error: string | null;
  onRetry: () => void;
}) {
  if (error === null) return null;
  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-xs text-red-600 dark:text-red-400"
    >
      <span>Could not load linked threads: {error}</span>
      <button
        type="button"
        className="shrink-0 rounded border border-border px-2 py-1 font-medium text-foreground hover:bg-accent"
        onClick={onRetry}
      >
        Retry links
      </button>
    </div>
  );
}

function useSpawn(): {
  spawn: (
    method: "startWork" | "startReview",
    repo: string,
    number: number,
  ) => void;
  spawningKey: string | null;
} {
  const rpc = useRpc<typeof githubRpcContract>();
  const navigate = useBbNavigate();
  const [spawningKey, setSpawningKey] = useState<string | null>(null);
  const spawn = useCallback(
    (method: "startWork" | "startReview", repo: string, number: number) => {
      setSpawningKey(`${repo}#${number}`);
      rpc
        .call(method, { repo, number })
        .then((result) => {
          const threadId = (result as { threadId?: unknown })?.threadId;
          if (typeof threadId !== "string")
            throw new Error("malformed spawn result");
          navigate.toThread(threadId);
        })
        .catch((error: unknown) => toast.error(errorText(error)))
        .finally(() => setSpawningKey(null));
    },
    [rpc, navigate],
  );
  return { spawn, spawningKey };
}

let viewerLogin: string | null = null;

function useViewer(): string | null {
  const rpc = useRpc<typeof githubRpcContract>();
  const [login, setLogin] = useState<string | null>(viewerLogin);
  useEffect(() => {
    if (viewerLogin !== null) return;
    rpc.call("viewer").then(
      (result) => {
        const value = (result as { login?: unknown })?.login;
        if (typeof value === "string" && value.length > 0) {
          viewerLogin = value;
          setLogin(value);
        }
      },
      () => {},
    );
  }, [rpc]);
  return login;
}

function Avatar({
  login,
  size = "size-5",
  className,
}: {
  login: string;
  size?: string;
  className?: string;
}) {
  const initials = login
    .trim()
    .split(/[\\s_-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0] ?? "")
    .join("")
    .toUpperCase() || "?";
  return (
    <span
      role="img"
      aria-label={login}
      title={login}
      className={`${size} inline-flex shrink-0 items-center justify-center rounded-full bg-muted text-[9px] font-semibold text-muted-foreground ${className ?? ""}`}
    >
      {initials}
    </span>
  );
}

function ChevronDownIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0 opacity-50"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function SearchIcon({ className }: { className?: string }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3-3" />
    </svg>
  );
}

function RefreshIcon({ className }: { className?: string }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M21 12a9 9 0 0 0-15.2-6.5L3 8" />
      <path d="M3 3v5h5" />
      <path d="M3 12a9 9 0 0 0 15.2 6.5L21 16" />
      <path d="M16 16h5v5" />
    </svg>
  );
}

function stateDotClass(kind: "issue" | "pr", state: string): string {
  if (state === "OPEN") return "bg-green-500";
  if (kind === "pr" && state === "MERGED") return "bg-purple-500";
  if (kind === "pr") return "bg-red-500";
  return "bg-purple-500";
}

function StateDot({ kind, state }: { kind: "issue" | "pr"; state: string }) {
  return (
    <span
      className={`size-2 shrink-0 rounded-full ${stateDotClass(kind, state)}`}
    />
  );
}

function StateBadge({ kind, state }: { kind: "issue" | "pr"; state: string }) {
  return (
    <Badge variant="outline" className="gap-1.5 font-normal">
      <StateDot kind={kind} state={state} />
      {state.toLowerCase()}
    </Badge>
  );
}

function ThreadPills({ links }: { links: ThreadLink[] | undefined }) {
  const navigate = useBbNavigate();
  if (links === undefined || links.length === 0) return null;
  return (
    <span className="flex shrink-0 items-center gap-1">
      {links.map((link, index) => (
        <button
          key={link.threadId}
          type="button"
          title={`Open BB thread ${link.threadId}`}
          aria-label={`Open BB thread ${link.threadId}`}
          onClick={(event) => {
            event.stopPropagation();
            navigate.toThread(link.threadId);
          }}
          className="inline-flex items-center rounded-md border border-transparent bg-secondary px-2.5 py-0.5 text-xs font-semibold text-secondary-foreground transition-colors cursor-pointer whitespace-nowrap hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          ⚡ agent{links.length > 1 ? ` ${index + 1}` : ""}
        </button>
      ))}
    </span>
  );
}

function LabelChips({
  labels,
  className,
}: {
  labels: string[];
  className?: string;
}) {
  if (labels.length === 0) return null;
  return (
    <span className={`items-center gap-1 ${className ?? "flex shrink-0"}`}>
      {labels.slice(0, 3).map((label) => (
        <Badge
          key={label}
          variant="secondary"
          className="font-normal text-muted-foreground"
        >
          {label}
        </Badge>
      ))}
    </span>
  );
}

function useIssueMutations() {
  const rpc = useRpc<typeof githubRpcContract>();
  const setIssueState = useCallback(
    (repo: string, number: number, state: "open" | "closed") =>
      rpc
        .call("setIssueState", { repo, number, state })
        .then(() =>
          toast.success(
            state === "closed" ? `#${number} closed` : `#${number} reopened`,
          ),
        ),
    [rpc],
  );
  const setAssignees = useCallback(
    (repo: string, number: number, assignees: string[]) =>
      rpc.call("setAssignees", { repo, number, assignees }),
    [rpc],
  );
  const setLabels = useCallback(
    (repo: string, number: number, labels: string[]) =>
      rpc.call("setLabels", { repo, number, labels }),
    [rpc],
  );
  return { setIssueState, setAssignees, setLabels };
}

function FilterSuggestionIcon({ icon }: { icon: SuggestionIcon }) {
  if (icon.kind === "state") {
    return <StateDot kind={icon.itemKind} state={icon.state} />;
  }
  return <Avatar login={icon.login} size="size-4" />;
}

function FilterBar({
  value,
  onChange,
  items,
  repos,
  kind,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  items: Item[] | null;
  repos: RepoInfo[];
  kind: "issue" | "pr" | "dependabot";
  placeholder?: string;
}) {
  const viewer = useViewer();
  const inputRef = useRef<HTMLInputElement>(null);
  const suggestionListId = useId();
  const [open, setOpen] = useState(false);
  const [caret, setCaret] = useState(value.length);
  const [highlight, setHighlight] = useState(0);

  const vocab = useMemo(() => {
    const users = new Set<string>();
    const labels = new Set<string>();
    for (const item of items ?? []) {
      if (item.author.length > 0) users.add(item.author);
      for (const login of item.assignees) users.add(login);
      for (const label of item.labels) labels.add(label);
    }
    return {
      users: [...users].sort((a, b) => a.localeCompare(b)),
      labels: [...labels].sort((a, b) => a.localeCompare(b)),
      repos: repos.map((entry) => entry.repo),
    };
  }, [items, repos]);

  const upToCaret = value.slice(0, caret);
  const tokenStart = upToCaret.lastIndexOf(" ") + 1;
  const token = upToCaret.slice(tokenStart);
  const suggestions = useMemo(
    () => buildSuggestions(token, vocab, kind, viewer).slice(0, 8),
    [token, vocab, kind, viewer],
  );
  const active = Math.min(highlight, Math.max(0, suggestions.length - 1));

  const syncCaret = () =>
    setCaret(inputRef.current?.selectionStart ?? value.length);

  const accept = (suggestion: Suggestion) => {
    const next =
      value.slice(0, tokenStart) + suggestion.insert + value.slice(caret);
    onChange(next);
    const position = tokenStart + suggestion.insert.length;
    setCaret(position);
    setHighlight(0);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(position, position);
    });
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }
    if (!open || suggestions.length === 0) {
      if (event.key === "ArrowDown") setOpen(true);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlight((active + 1) % suggestions.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight((active - 1 + suggestions.length) % suggestions.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      accept(suggestions[active]);
    }
  };

  return (
    <div className="relative">
      <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <input
        ref={inputRef}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
          setHighlight(0);
          setCaret(event.target.selectionStart ?? event.target.value.length);
        }}
        onSelect={syncCaret}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open && suggestions.length > 0}
        aria-controls={suggestionListId}
        aria-activedescendant={
          open && suggestions.length > 0
            ? `${suggestionListId}-option-${active}`
            : undefined
        }
        placeholder={placeholder ?? "Filter — is:open assignee:@me label:bug, or plain text"}
        className="flex h-9 w-full rounded-lg border border-input bg-transparent py-1 pl-9 pr-8 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        spellCheck={false}
        autoComplete="off"
      />
      {value.length > 0 ? (
        <button
          type="button"
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
          onMouseDown={(event) => {
            event.preventDefault();
            onChange("");
            setCaret(0);
            inputRef.current?.focus();
          }}
          aria-label="Clear filter"
        >
          ✕
        </button>
      ) : null}
      {open && suggestions.length > 0 ? (
        <div
          id={suggestionListId}
          role="listbox"
          className="absolute left-0 right-0 top-full z-50 mt-1 max-h-72 overflow-y-auto rounded-md border border-border bg-popover py-1 shadow-md"
        >
          {suggestions.map((suggestion, index) => (
            <button
              type="button"
              id={`${suggestionListId}-option-${index}`}
              role="option"
              aria-selected={index === active}
              key={suggestion.insert}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${
                index === active
                  ? "bg-accent text-accent-foreground"
                  : "text-popover-foreground"
              }`}
              onMouseDown={(event) => {
                event.preventDefault();
                accept(suggestion);
              }}
              onMouseEnter={() => setHighlight(index)}
            >
              {suggestion.icon !== undefined ? (
                <FilterSuggestionIcon icon={suggestion.icon} />
              ) : null}
              <span className="min-w-0 truncate font-medium">
                {suggestion.label}
              </span>
              {suggestion.hint !== undefined ? (
                <span className="ml-auto shrink-0 pl-4 text-xs text-muted-foreground">
                  {suggestion.hint}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

const COL = {
  id: "shrink-0 @[48rem]:w-12",
  assignee: "shrink-0 @[48rem]:w-20",
  status: "shrink-0 @[48rem]:w-24",
  updated: "hidden w-16 shrink-0 text-right @[48rem]:block",
  actions:
    "ml-auto flex shrink-0 items-center justify-end gap-1 @[48rem]:ml-0 @[48rem]:w-24",
} as const;

function AssigneeCell({ assignees }: { assignees: string[] }) {
  if (assignees.length === 0) {
    return <span className="text-muted-foreground/50">—</span>;
  }
  return (
    <span
      className="flex items-center -space-x-1.5"
      title={assignees.join(", ")}
    >
      {assignees.slice(0, 3).map((login) => (
        <Avatar key={login} login={login} className="ring-1 ring-card" />
      ))}
      {assignees.length > 3 ? (
        <span className="pl-2.5 text-xs text-muted-foreground">
          +{assignees.length - 3}
        </span>
      ) : null}
    </span>
  );
}

function StatusCell({ item }: { item: Item }) {
  const { setIssueState } = useIssueMutations();
  const [pending, setPending] = useState(false);
  if (item.kind === "pr") {
    return <StateBadge kind="pr" state={item.state} />;
  }
  const change = (next: "open" | "closed") => {
    if ((item.state === "OPEN") === (next === "open")) return;
    setPending(true);
    setIssueState(item.repo, item.number, next)
      .catch((error: unknown) => toast.error(errorText(error)))
      .finally(() => setPending(false));
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={pending}>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1.5 px-2 text-xs font-normal"
          onClick={(event) => event.stopPropagation()}
          aria-label={`Change issue #${item.number} state, currently ${item.state.toLowerCase()}`}
          aria-busy={pending}
        >
          <StateDot kind="issue" state={item.state} />
          <span className="inline-flex items-center gap-1">
            {pending ? <Spinner className="size-3" /> : null}
            {item.state.toLowerCase()}
          </span>
          <ChevronDownIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem onSelect={() => change("open")}>
          <StateDot kind="issue" state="OPEN" />
          Open
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => change("closed")}>
          <StateDot kind="issue" state="CLOSED" />
          Closed
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RowMenu({ item }: { item: Item }) {
  const navigate = useBbNavigate();
  const viewer = useViewer();
  const { setIssueState, setAssignees } = useIssueMutations();
  const assignedToMe = viewer !== null && item.assignees.includes(viewer);
  const safeUrl = isSafeExternalUrl(item.url);

  const toggleSelfAssign = () => {
    if (viewer === null) return;
    const next = assignedToMe
      ? item.assignees.filter((login) => login !== viewer)
      : [...item.assignees, viewer];
    setAssignees(item.repo, item.number, next)
      .then(() =>
        toast.success(
          assignedToMe
            ? `Unassigned from #${item.number}`
            : `Assigned to #${item.number}`,
        ),
      )
      .catch((error: unknown) => toast.error(errorText(error)));
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          className="size-7 text-muted-foreground"
          onClick={(event) => event.stopPropagation()}
          aria-label={`More actions for ${item.kind === "pr" ? "pull request" : "issue"} #${item.number}`}
        >
          ⋮
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {item.kind === "issue" && viewer !== null ? (
          <DropdownMenuItem onSelect={toggleSelfAssign}>
            {assignedToMe ? "Unassign me" : "Assign to me"}
          </DropdownMenuItem>
        ) : null}
        {item.kind === "issue" ? (
          <DropdownMenuItem
            onSelect={() =>
              setIssueState(
                item.repo,
                item.number,
                item.state === "OPEN" ? "closed" : "open",
              ).catch((error: unknown) => toast.error(errorText(error)))
            }
          >
            {item.state === "OPEN" ? "Close issue" : "Reopen issue"}
          </DropdownMenuItem>
        ) : null}
        {item.kind === "issue" ? <DropdownMenuSeparator /> : null}
        <DropdownMenuItem
          disabled={!safeUrl}
          onSelect={() => {
            if (safeUrl) navigate.openUrl(item.url);
          }}
        >
          Open on GitHub ↗
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => {
            navigator.clipboard.writeText(item.url).then(
              () => toast.success("Link copied"),
              () => toast.error("Could not copy the link"),
            );
          }}
        >
          Copy link
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ItemRow({
  item,
  links,
  onOpen,
}: {
  item: Item;
  links: ThreadLink[] | undefined;
  onOpen: () => void;
}) {
  const { spawn, spawningKey } = useSpawn();
  const busy = spawningKey === `${item.repo}#${item.number}`;
  return (
    <div
      className="grid grid-cols-1 gap-y-2 px-3 py-3 transition-colors hover:bg-accent/50 @[48rem]:flex @[48rem]:items-center @[48rem]:gap-3 @[48rem]:py-2.5"
    >
      <span className="flex min-w-0 items-start gap-2.5 @[48rem]:order-2 @[48rem]:flex-1 @[48rem]:items-center">
        {item.author.length > 0 ? (
          <Avatar login={item.author} className="mt-0.5 @[48rem]:mt-0" />
        ) : null}
        <span className="flex min-w-0 flex-1 flex-col items-start gap-1.5 @[48rem]:flex-row @[48rem]:items-center @[48rem]:gap-2">
          <button
            type="button"
            className="min-w-0 flex-1 bg-transparent p-0 text-left"
            aria-label={`View ${item.kind === "pr" ? "pull request" : "issue"} #${item.number} in ${item.repo}`}
            onClick={onOpen}
          >
            <span
              className="block line-clamp-3 text-sm font-medium leading-snug text-foreground @[48rem]:line-clamp-1 @[48rem]:leading-normal"
              title={item.title}
            >
              {item.title}
            </span>
            <span className="mt-0.5 block truncate text-xs font-normal text-muted-foreground">
              {item.kind === "pr"
                ? `by ${item.author || "unknown"} · ${item.repo}`
                : `${item.repo}${item.author.length > 0 ? ` · by ${item.author}` : ""}`}
            </span>
          </button>
          <LabelChips
            labels={item.labels}
            className="hidden shrink-0 @[60rem]:flex"
          />
          <ThreadPills links={links} />
        </span>
      </span>
      <span className="flex min-w-0 items-center gap-2 @[48rem]:contents">
        <span
          className={`${COL.id} font-mono text-xs text-muted-foreground @[48rem]:order-1`}
        >
          #{item.number}
        </span>
        <span
          className={`${COL.assignee} ${item.assignees.length === 0 ? "hidden @[48rem]:flex" : "flex"} text-xs text-muted-foreground @[48rem]:order-3`}
        >
          <AssigneeCell assignees={item.assignees} />
        </span>
        <span className={`${COL.status} @[48rem]:order-4`}>
          <StatusCell item={item} />
        </span>
        <span
          className={`${COL.updated} text-xs text-muted-foreground @[48rem]:order-5`}
        >
          {relativeTime(item.updatedAt)}
        </span>
        <span className={`${COL.actions} @[48rem]:order-6`}>
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1.5"
            disabled={spawningKey !== null}
            aria-busy={busy}
            onClick={(event) => {
              event.stopPropagation();
              spawn(
                item.kind === "issue" ? "startWork" : "startReview",
                item.repo,
                item.number,
              );
            }}
          >
            {busy ? <Spinner className="size-3" /> : null}
            {item.kind === "issue" ? "Start" : "Review"}
          </Button>
          <RowMenu item={item} />
        </span>
      </span>
    </div>
  );
}

function TableSkeleton({
  label,
  rows = 6,
}: {
  label: string;
  rows?: number;
}) {
  return (
    <div role="status" aria-live="polite" aria-busy="true" aria-label={label}>
      <span className="sr-only">{label}</span>
      <div className="divide-y divide-border">
        {Array.from({ length: rows }, (_, row) => (
          <div
            key={row}
            className="grid grid-cols-1 gap-y-3 px-3 py-3 @[48rem]:flex @[48rem]:items-center @[48rem]:gap-3"
          >
            <div className="flex min-w-0 flex-col gap-2 @[48rem]:order-2 @[48rem]:flex-1">
              <Skeleton className="h-3 w-4/5" />
              <Skeleton className="h-3 w-1/3" />
            </div>
            <span className="flex items-center gap-2 @[48rem]:contents">
              <span className={`${COL.id} @[48rem]:order-1`}>
                <Skeleton className="h-3 w-10" />
              </span>
              <span className={`${COL.assignee} flex @[48rem]:order-3`}>
                <Skeleton className="size-5 rounded-full" />
              </span>
              <span className={`${COL.status} @[48rem]:order-4`}>
                <Skeleton className="h-5 w-16 rounded-full" />
              </span>
              <span className={`${COL.updated} @[48rem]:order-5`}>
                <Skeleton className="ml-auto h-3 w-12" />
              </span>
              <span className={`${COL.actions} @[48rem]:order-6`}>
                <Skeleton className="h-7 w-16" />
              </span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function DetailSkeleton({
  label = "Loading details",
  compact = false,
}: {
  label?: string;
  compact?: boolean;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label={label}
      className="flex flex-col gap-4"
    >
      <span className="sr-only">{label}</span>
      <Skeleton className="h-4 w-40" />
      <div className="flex items-start gap-3">
        <Skeleton className={`h-7 ${compact ? "w-1/2" : "w-2/3"}`} />
        <Skeleton className="h-8 w-24 shrink-0" />
      </div>
      {compact ? (
        <Skeleton className="h-28 w-full" />
      ) : (
        <div className="flex flex-col gap-6 lg:flex-row">
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <div className="overflow-hidden rounded-lg border border-border">
              <Skeleton className="h-9 w-full rounded-none" />
              <div className="flex flex-col gap-2 p-4">
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-5/6" />
                <Skeleton className="h-3 w-2/3" />
              </div>
            </div>
            <Skeleton className="h-24 w-full" />
          </div>
          <aside className="flex w-full shrink-0 flex-col gap-3 lg:w-56">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </aside>
        </div>
      )}
    </div>
  );
}

function RepositoryManagerSkeleton() {
  return (
    <section
      className="overflow-hidden rounded-lg border border-border bg-card"
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label="Loading repositories"
    >
      <span className="sr-only">Loading repositories</span>
      <div className="flex items-start justify-between gap-3 border-b border-border bg-muted/50 px-4 py-3">
        <div className="min-w-0 flex-1">
          <Skeleton className="h-4 w-44" />
          <Skeleton className="mt-2 h-3 w-64" />
        </div>
        <Skeleton className="h-5 w-8 rounded-full" />
      </div>
      {[0, 1].map((row) => (
        <div
          key={row}
          className="flex flex-col gap-3 border-t border-border px-4 py-3 @[48rem]:flex-row @[48rem]:items-center"
        >
          <div className="min-w-0 flex-1">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="mt-2 h-3 w-32" />
          </div>
          <div className="flex gap-2">
            <Skeleton className="h-10 w-16" />
            <Skeleton className="h-10 w-16" />
            <Skeleton className="h-10 w-16" />
          </div>
          <Skeleton className="h-8 w-20" />
        </div>
      ))}
    </section>
  );
}

function ItemsTable({
  kind,
  items,
  error,
  loading,
  hasFilter,
  onRetry,
  onClearFilter,
  onOpenItem,
  page,
  pageCount,
  total,
  pageSize,
  showPagination,
  onPageChange,
}: {
  kind: "issue" | "pr";
  items: Item[] | null;
  error: string | null;
  loading: boolean;
  hasFilter: boolean;
  onRetry: () => void;
  onClearFilter?: () => void;
  onOpenItem: (repo: string, number: number) => void;
  page: number;
  pageCount: number;
  total: number;
  pageSize: number;
  showPagination: boolean;
  onPageChange: (page: number) => void;
}) {
  const { links, error: linksError, refetch: retryLinks } = useLinks();
  const noun = kind === "issue" ? "issues" : "pull requests";

  let body: React.ReactNode;
  if (error !== null && items === null) {
    body = (
      <EmptyState
        title={`Couldn't load ${noun}`}
        message={error}
        onRetry={onRetry}
      />
    );
  } else if (items === null) {
    body = (
      <TableSkeleton
        label={kind === "issue" ? "Loading issues" : "Loading pull requests"}
      />
    );
  } else if (items.length === 0) {
    body = (
      <EmptyState
        title={hasFilter ? "No matches" : `No ${noun}`}
        message={
          hasFilter
            ? `No ${noun} match this filter.`
            : `No ${noun} in the tracked repos.`
        }
        actionLabel={hasFilter ? "Clear filter" : undefined}
        onAction={hasFilter ? onClearFilter : undefined}
      />
    );
  } else {
    body = (
      <div className="divide-y divide-border">
        {items.map((item) => (
          <ItemRow
            key={`${item.repo}#${item.number}`}
            item={item}
            links={links[`${kind}:${item.repo}#${item.number}`]}
            onOpen={() => onOpenItem(item.repo, item.number)}
          />
        ))}
      </div>
    );
  }

  return (
    <div
      className="@container overflow-hidden rounded-lg border border-border bg-card"
      aria-busy={loading}
    >
      <div className="hidden items-center gap-3 border-b border-border bg-muted/50 px-3 py-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground @[48rem]:flex">
        <span className={COL.id}>ID</span>
        <span className="min-w-0 flex-1">Title</span>
        <span className={COL.assignee}>Assignee</span>
        <span className={COL.status}>Status</span>
        <span className={COL.updated}>Updated</span>
        <span className={COL.actions} />
      </div>
      {loading && items !== null ? (
        <>
          <span className="sr-only">Updating {noun}</span>
          <RefreshBar visible />
        </>
      ) : null}
      {error !== null && items !== null ? (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 border-b border-border px-3 py-2 text-xs text-red-600 dark:text-red-400"
        >
          <span>Could not refresh {noun}: {error}</span>
          <Button size="sm" variant="outline" className="h-7 shrink-0" onClick={onRetry}>
            Retry
          </Button>
        </div>
      ) : null}
      <LinkErrorNotice error={linksError} onRetry={retryLinks} />
      {body}
      {showPagination && items !== null && total > 0 ? (
        <PageControls
          page={page}
          pageSize={pageSize}
          total={total}
          pageCount={pageCount}
          onPageChange={onPageChange}
        />
      ) : null}
    </div>
  );
}

function PageControls({
  page,
  pageSize,
  total,
  pageCount: pageCountProp,
  onPageChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  pageCount?: number;
  onPageChange: (page: number) => void;
}) {
  const start = page * pageSize + 1;
  const end = Math.min((page + 1) * pageSize, total);
  const pageCount = pageCountProp ?? Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-3 py-2">
      <span className="text-xs text-muted-foreground">
        Showing {start}–{end} of {total}
      </span>
      {pageCount > 1 ? (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={page === 0}
            onClick={() => onPageChange(page - 1)}
          >
            Previous
          </Button>
          <span className="text-xs text-muted-foreground">
            Page {page + 1} of {pageCount}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={page + 1 >= pageCount}
            onClick={() => onPageChange(page + 1)}
          >
            Next
          </Button>
        </div>
      ) : (
        <span className="text-xs text-muted-foreground">
          Page 1 of 1
        </span>
      )}
    </div>
  );
}

function SidebarHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
      {children}
    </h3>
  );
}

function AssigneePicker({
  repo,
  assignees,
  onToggle,
}: {
  repo: string;
  assignees: string[];
  onToggle: (login: string, assigned: boolean) => void;
}) {
  const rpc = useRpc<typeof githubRpcContract>();
  const viewer = useViewer();
  const [users, setUsers] = useState<string[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const requestRef = useRef(0);

  useEffect(() => {
    requestRef.current += 1;
    setUsers(null);
    setLoadError(null);
  }, [repo]);

  const load = useCallback(() => {
    if (users !== null) return;
    const requestId = ++requestRef.current;
    rpc.call("assignableUsers", { repo }).then(
      (result) => {
        if (requestId !== requestRef.current) return;
        const list = (result as { users?: unknown })?.users;
        setUsers(Array.isArray(list) ? list.map(String) : []);
      },
      (error: unknown) => {
        if (requestId === requestRef.current) setLoadError(errorText(error));
      },
    );
  }, [rpc, repo, users]);

  const ordered =
    users === null
      ? null
      : [...users].sort((a, b) => Number(b === viewer) - Number(a === viewer));

  return (
    <DropdownMenu onOpenChange={(open) => open && load()}>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-xs text-muted-foreground"
        >
          Edit
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="max-h-72 w-56 overflow-y-auto"
      >
        <DropdownMenuLabel>Assignees</DropdownMenuLabel>
        {loadError !== null ? (
          <DropdownMenuItem onSelect={load}>{loadError} — Retry</DropdownMenuItem>
        ) : ordered === null ? (
          <MenuLoading label="Loading assignees" />
        ) : ordered.length === 0 ? (
          <DropdownMenuItem disabled>No assignable users</DropdownMenuItem>
        ) : (
          ordered.map((login) => (
            <DropdownMenuCheckboxItem
              key={login}
              checked={assignees.includes(login)}
              onCheckedChange={(checked) => onToggle(login, checked)}
              onSelect={(event) => event.preventDefault()}
            >
              <span className="flex min-w-0 items-center gap-2">
                <Avatar login={login} size="size-4" />
                <span className="truncate">
                  {login}
                  {login === viewer ? " (you)" : ""}
                </span>
              </span>
            </DropdownMenuCheckboxItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function LabelPicker({
  repo,
  labels,
  onToggle,
}: {
  repo: string;
  labels: string[];
  onToggle: (label: string, enabled: boolean) => void;
}) {
  const rpc = useRpc<typeof githubRpcContract>();
  const [available, setAvailable] = useState<string[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const requestRef = useRef(0);

  useEffect(() => {
    requestRef.current += 1;
    setAvailable(null);
    setLoadError(null);
  }, [repo]);

  const load = useCallback(() => {
    if (available !== null) return;
    const requestId = ++requestRef.current;
    rpc.call("repositoryLabels", { repo }).then(
      (result) => {
        if (requestId !== requestRef.current) return;
        const list = (result as { labels?: unknown })?.labels;
        setAvailable(Array.isArray(list) ? list.map(String) : []);
      },
      (error: unknown) => {
        if (requestId === requestRef.current) setLoadError(errorText(error));
      },
    );
  }, [rpc, repo, available]);

  const ordered =
    available === null
      ? null
      : [...new Set([...labels, ...available])].sort((a, b) =>
          a.localeCompare(b),
        );

  return (
    <DropdownMenu onOpenChange={(open) => open && load()}>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-xs text-muted-foreground"
        >
          Edit
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="max-h-72 w-56 overflow-y-auto"
      >
        <DropdownMenuLabel>Labels</DropdownMenuLabel>
        {loadError !== null ? (
          <DropdownMenuItem onSelect={load}>{loadError} — Retry</DropdownMenuItem>
        ) : ordered === null ? (
          <MenuLoading label="Loading labels" />
        ) : ordered.length === 0 ? (
          <DropdownMenuItem disabled>No labels in repo</DropdownMenuItem>
        ) : (
          ordered.map((label) => (
            <DropdownMenuCheckboxItem
              key={label}
              checked={labels.includes(label)}
              onCheckedChange={(checked) => onToggle(label, checked === true)}
              onSelect={(event) => event.preventDefault()}
            >
              <span className="min-w-0 truncate">{label}</span>
            </DropdownMenuCheckboxItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function IssueDetailView({
  repo,
  number,
  onBack,
}: {
  repo: string;
  number: number;
  onBack: () => void;
}) {
  const rpc = useRpc<typeof githubRpcContract>();
  const { links, error: linksError, refetch: retryLinks } = useLinks();
  const { spawn, spawningKey } = useSpawn();
  const { setIssueState, setAssignees, setLabels } = useIssueMutations();
  const [detail, setDetail] = useState<IssueDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [comment, setComment] = useState("");
  const [posting, setPosting] = useState(false);
  const detailKey = `${repo}#${number}`;
  const activeDetailKey = useRef(detailKey);
  activeDetailKey.current = detailKey;
  const loadRequest = useRef(0);
  const detailRef = useRef<IssueDetail | null>(null);
  const assigneeQueue = useRef<Promise<unknown>>(Promise.resolve());
  const labelQueue = useRef<Promise<unknown>>(Promise.resolve());
  const stateQueue = useRef<Promise<unknown>>(Promise.resolve());
  const [statePending, setStatePending] = useState(false);
  const assigneeMutationVersion = useRef(0);
  const labelMutationVersion = useRef(0);
  const stateMutationVersion = useRef(0);

  const load = useCallback(() => {
    const requestId = ++loadRequest.current;
    const requestKey = detailKey;
    setLoading(true);
    rpc.call("getIssue", { repo, number }).then(
      (result) => {
        if (requestId !== loadRequest.current || activeDetailKey.current !== requestKey) return;
        const issue = (result as { issue?: IssueDetail })?.issue;
        if (issue === undefined || issue === null) {
          detailRef.current = null;
          setDetail(null);
          setError("malformed getIssue result");
          setLoading(false);
          return;
        }
        detailRef.current = issue;
        setDetail(issue);
        setError(null);
        setLoading(false);
      },
      (err: unknown) => {
        if (requestId === loadRequest.current && activeDetailKey.current === requestKey) {
          setError(errorText(err));
          setLoading(false);
        }
      },
    );
  }, [rpc, repo, number, detailKey]);
  useEffect(() => {
    detailRef.current = null;
    setDetail(null);
    setError(null);
    setLoading(true);
    stateMutationVersion.current += 1;
    setStatePending(false);
    load();
    return () => {
      loadRequest.current += 1;
      stateMutationVersion.current += 1;
    };
  }, [load]);

  const changeState = useCallback(
    (next: "open" | "closed") => {
      if (statePending) return;
      const current = detailRef.current;
      if (current !== null) {
        const optimistic = {
          ...current,
          state: next === "closed" ? "CLOSED" : "OPEN",
        };
        detailRef.current = optimistic;
        setDetail(optimistic);
      }
      setStatePending(true);
      const requestId = ++stateMutationVersion.current;
      const request = stateQueue.current
        .catch(() => undefined)
        .then(() => {
          if (activeDetailKey.current !== detailKey) return;
          return setIssueState(repo, number, next);
        });
      stateQueue.current = request;
      request.catch((err: unknown) => {
        if (
          requestId !== stateMutationVersion.current ||
          activeDetailKey.current !== detailKey
        ) {
          return;
        }
        toast.error(errorText(err));
        load();
      });
      request.then(
        () => {
          if (requestId === stateMutationVersion.current && activeDetailKey.current === detailKey) {
            setStatePending(false);
          }
        },
        () => {
          if (requestId === stateMutationVersion.current && activeDetailKey.current === detailKey) {
            setStatePending(false);
          }
        },
      );
    },
    [setIssueState, repo, number, load, detailKey, statePending],
  );

  const toggleAssignee = useCallback(
    (login: string, assigned: boolean) => {
      const current = detailRef.current;
      if (current === null || activeDetailKey.current !== detailKey) return;
      const next = assigned
        ? [...new Set([...current.assignees, login])]
        : current.assignees.filter((entry) => entry !== login);
      const optimistic = { ...current, assignees: next };
      detailRef.current = optimistic;
      setDetail(optimistic);

      const requestId = ++assigneeMutationVersion.current;
      const request = assigneeQueue.current
        .catch(() => undefined)
        .then(() => {
          if (activeDetailKey.current !== detailKey) return;
          return setAssignees(repo, number, next);
        });
      assigneeQueue.current = request;
      request.catch((err: unknown) => {
        if (
          requestId !== assigneeMutationVersion.current ||
          activeDetailKey.current !== detailKey
        ) {
          return;
        }
        toast.error(errorText(err));
        load();
      });
    },
    [setAssignees, repo, number, load, detailKey],
  );

  const toggleLabel = useCallback(
    (label: string, enabled: boolean) => {
      const current = detailRef.current;
      if (current === null || activeDetailKey.current !== detailKey) return;
      const next = enabled
        ? [...new Set([...current.labels, label])]
        : current.labels.filter((entry) => entry !== label);
      const optimistic = { ...current, labels: next };
      detailRef.current = optimistic;
      setDetail(optimistic);

      const requestId = ++labelMutationVersion.current;
      const request = labelQueue.current
        .catch(() => undefined)
        .then(() => {
          if (activeDetailKey.current !== detailKey) return;
          return setLabels(repo, number, next);
        });
      labelQueue.current = request;
      request.catch((err: unknown) => {
        if (
          requestId !== labelMutationVersion.current ||
          activeDetailKey.current !== detailKey
        ) {
          return;
        }
        toast.error(errorText(err));
        load();
      });
    },
    [setLabels, repo, number, load, detailKey],
  );

  const postComment = useCallback(() => {
    if (comment.trim().length === 0) return;
    setPosting(true);
    rpc
      .call("commentIssue", { repo, number, body: comment })
      .then(() => {
        setComment("");
        load();
      })
      .catch((err: unknown) => toast.error(errorText(err)))
      .finally(() => setPosting(false));
  }, [rpc, repo, number, comment, load]);

  if (detail === null && error !== null) {
    return (
      <EmptyState
        title="Couldn't load issue"
        message={error}
        onRetry={load}
      />
    );
  }
  if (detail === null) {
    return <DetailSkeleton label="Loading issue" />;
  }

  const issueLinks = links[`issue:${repo}#${number}`];
  return (
    <div className="flex flex-col gap-4" aria-busy={loading || posting || statePending}>
      {loading ? <RefreshBar visible /> : null}
      {error !== null ? (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-xs text-red-600 dark:text-red-400"
        >
          <span>Could not refresh this issue: {error}</span>
          <Button size="sm" variant="outline" className="h-7 shrink-0" onClick={load}>
            Retry
          </Button>
        </div>
      ) : null}
      <LinkErrorNotice error={linksError} onRetry={retryLinks} />
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        <Button size="sm" variant="ghost" className="h-7 px-2" onClick={onBack}>
          ← Issues
        </Button>
        <span>
          {repo} · #{number}
        </span>
        <span className="flex-1" />
        <SafeUrlLink href={detail.url} className="underline hover:text-foreground">
          Open on GitHub ↗
        </SafeUrlLink>
      </div>

      <div className="flex items-start gap-3">
        <h2 className="min-w-0 flex-1 text-xl font-semibold text-foreground">
          {detail.title}{" "}
          <span className="font-normal text-muted-foreground">
            #{detail.number}
          </span>
        </h2>
        <Button
          size="sm"
          className="gap-1.5"
          disabled={spawningKey !== null}
          aria-busy={spawningKey !== null}
          onClick={() => spawn("startWork", repo, number)}
        >
          {spawningKey !== null ? <Spinner className="size-3" /> : null}
          {spawningKey !== null ? "Starting…" : "Send agent"}
        </Button>
      </div>

      <div className="flex flex-col gap-6 lg:flex-row">
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <div className="overflow-hidden rounded-lg border border-border bg-card">
            <div className="flex items-center gap-2 border-b border-border bg-muted/50 px-4 py-2 text-xs text-muted-foreground">
              <Avatar login={detail.author} />
              <span className="font-medium text-foreground">
                {detail.author}
              </span>
              opened this issue · updated {relativeTime(detail.updatedAt)}
            </div>
            <div className="p-4">
              {detail.body.length > 0 ? (
                <Markdown content={detail.body} className="text-sm" />
              ) : (
                <p className="text-sm text-muted-foreground">
                  (no description)
                </p>
              )}
            </div>
          </div>

          {detail.comments.length > 0 ? (
            <div className="flex flex-col gap-2">
              <h3 className="text-xs font-semibold text-muted-foreground">
                Activity · {detail.comments.length}
              </h3>
              {detail.comments.map((entry, index) => (
                <div
                  key={index}
                  className="rounded-lg border border-border bg-card p-3"
                >
                  <p className="mb-1.5 flex items-center gap-2 text-xs text-muted-foreground">
                    <Avatar login={entry.author} />
                    <span className="font-medium text-foreground">
                      {entry.author}
                    </span>{" "}
                    · {relativeTime(entry.createdAt)}
                  </p>
                  <Markdown content={entry.body} className="text-sm" />
                </div>
              ))}
            </div>
          ) : null}

          <div className="flex flex-col gap-2">
            <Textarea
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              placeholder="Leave a comment…"
              rows={3}
            />
            <div className="flex justify-end">
              <Button
                size="sm"
                className="gap-1.5"
                disabled={posting || comment.trim().length === 0}
                aria-busy={posting}
                onClick={postComment}
              >
                {posting ? <Spinner className="size-3" /> : null}
                {posting ? "Posting…" : "Comment"}
              </Button>
            </div>
          </div>
        </div>

        <aside className="flex w-full shrink-0 flex-col gap-5 lg:w-56">
          <div className="flex flex-col gap-2">
            <SidebarHeading>Status</SidebarHeading>
            <Select
              value={detail.state === "OPEN" ? "open" : "closed"}
              onValueChange={(value) =>
                changeState(value === "closed" ? "closed" : "open")
              }
            >
              <SelectTrigger
                aria-label="Issue status"
                aria-busy={statePending}
                disabled={statePending}
                className="h-8 w-full text-sm"
              >
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  {statePending ? <Spinner className="size-3" /> : null}
                  <SelectValue />
                </span>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="open">
                  <span className="flex items-center gap-2">
                    <StateDot kind="issue" state="OPEN" /> Open
                  </span>
                </SelectItem>
                <SelectItem value="closed">
                  <span className="flex items-center gap-2">
                    <StateDot kind="issue" state="CLOSED" /> Closed
                  </span>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <SidebarHeading>Assignees</SidebarHeading>
              <AssigneePicker
                repo={repo}
                assignees={detail.assignees}
                onToggle={toggleAssignee}
              />
            </div>
            {detail.assignees.length === 0 ? (
              <p className="text-sm text-muted-foreground">No one assigned</p>
            ) : (
              detail.assignees.map((login) => (
                <p
                  key={login}
                  className="flex items-center gap-2 text-sm text-foreground"
                >
                  <Avatar login={login} />
                  <span className="truncate">{login}</span>
                </p>
              ))
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <SidebarHeading>Labels</SidebarHeading>
              <LabelPicker
                repo={repo}
                labels={detail.labels}
                onToggle={toggleLabel}
              />
            </div>
            {detail.labels.length === 0 ? (
              <p className="text-sm text-muted-foreground">None yet</p>
            ) : (
              <LabelChips labels={detail.labels} className="flex flex-wrap" />
            )}
          </div>

          {issueLinks !== undefined && issueLinks.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <SidebarHeading>Agents</SidebarHeading>
              <ThreadPills links={issueLinks} />
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

function pullStateBadgeParts(state: string): { dot: string; label: string } {
  if (state === "DRAFT")
    return { dot: "bg-muted-foreground/60", label: "draft" };
  if (state === "OPEN") return { dot: "bg-green-500", label: "open" };
  if (state === "MERGED") return { dot: "bg-purple-500", label: "merged" };
  return { dot: "bg-red-500", label: "closed" };
}

function PullStateBadge({ state }: { state: string }) {
  const { dot, label } = pullStateBadgeParts(state);
  return (
    <Badge variant="outline" className="gap-1.5 font-normal">
      <span className={`size-2 shrink-0 rounded-full ${dot}`} />
      {label}
    </Badge>
  );
}

const REVIEW_STATE_LABELS: Record<string, string> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "requested changes",
  COMMENTED: "commented",
  DISMISSED: "dismissed",
  PENDING: "review requested",
};

function reviewStateClass(state: string): string {
  if (state === "APPROVED") return "text-green-600 dark:text-green-400";
  if (state === "CHANGES_REQUESTED") return "text-red-600 dark:text-red-400";
  return "text-muted-foreground";
}

function ReviewDecisionBadge({ decision }: { decision: string }) {
  if (decision === "APPROVED") {
    return (
      <Badge className="bg-green-600 text-white hover:bg-green-600">
        approved
      </Badge>
    );
  }
  if (decision === "CHANGES_REQUESTED") {
    return <Badge variant="destructive">changes requested</Badge>;
  }
  if (decision === "REVIEW_REQUIRED") {
    return <Badge variant="secondary">review required</Badge>;
  }
  return null;
}

function checkDotClass(status: PullCheck["status"]): string {
  if (status === "success") return "bg-green-500";
  if (status === "failure") return "bg-red-500";
  if (status === "pending") return "animate-pulse bg-yellow-500";
  return "bg-muted-foreground/50";
}

function ChecksSection({ checks }: { checks: PullCheck[] }) {
  const [open, setOpen] = useState(() =>
    checks.some((check) => check.status === "failure"),
  );
  const checksId = useId();
  if (checks.length === 0) return null;
  const passing = checks.filter((check) => check.status === "success").length;
  const failing = checks.filter((check) => check.status === "failure").length;
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent/50"
        aria-expanded={open}
        aria-controls={checksId}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span
          className={`size-2 shrink-0 rounded-full ${
            failing > 0
              ? "bg-red-500"
              : passing === checks.length
                ? "bg-green-500"
                : "animate-pulse bg-yellow-500"
          }`}
        />
        <span className="font-medium text-foreground">Checks</span>
        <span className="text-xs text-muted-foreground">
          {passing}/{checks.length} passing
          {failing > 0 ? ` · ${failing} failing` : ""}
        </span>
        <span className="ml-auto text-xs text-muted-foreground">
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open ? (
        <div id={checksId} className="divide-y divide-border border-t border-border">
          {checks.map((check, index) => (
            <div
              key={`${check.name}-${index}`}
              className="flex items-center gap-2 px-3 py-1.5 text-xs"
            >
              <span
                className={`size-2 shrink-0 rounded-full ${checkDotClass(check.status)}`}
              />
              <span className="min-w-0 flex-1 truncate text-foreground">
                {check.name}
              </span>
              {check.url.length > 0 ? (
                <SafeUrlLink
                  href={check.url}
                  className="shrink-0 text-muted-foreground underline hover:text-foreground"
                >
                  details ↗
                </SafeUrlLink>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function FileDiffCard({
  file,
  url,
}: {
  file: PullFile;
  url: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex w-full items-center gap-2 px-3 py-2 hover:bg-accent/50">
        <button
          type="button"
          className="shrink-0 text-xs text-muted-foreground"
          aria-label={`${open ? "Collapse" : "Expand"} ${file.path} diff`}
          onClick={() => setOpen((prev) => !prev)}
        >
          {open ? "▾" : "▸"}
        </button>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
          {file.path}
        </span>
        {file.status !== "modified" ? (
          <Badge
            variant="secondary"
            className="shrink-0 font-normal text-muted-foreground"
          >
            {file.status}
          </Badge>
        ) : null}
        <span className="shrink-0 text-xs text-green-600 dark:text-green-400">
          +{file.additions}
        </span>
        <span className="shrink-0 text-xs text-red-600 dark:text-red-400">
          −{file.deletions}
        </span>
      </div>
      {open ? (
        file.patch !== null ? (
          <div className="border-t border-border">
            <Diff patch={file.patch} path={file.path} />
          </div>
        ) : (
          <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
            Diff too large to inline —{" "}
            <SafeUrlLink href={`${url}/files`} className="underline">
              view on GitHub ↗
            </SafeUrlLink>
          </p>
        )
      ) : null}
    </div>
  );
}

function FilesChangedSection({
  files,
  url,
  additions,
  deletions,
}: {
  files: PullFile[];
  url: string;
  additions: number;
  deletions: number;
}) {
  const [open, setOpen] = useState(false);
  if (files.length === 0) return null;
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-accent/50"
        onClick={() => setOpen((previous) => !previous)}
        aria-expanded={open}
      >
        <span className="size-2 shrink-0 rounded-full bg-muted-foreground/50" aria-hidden="true" />
        <span className="font-medium text-foreground">Files changed</span>
        <span className="text-xs text-muted-foreground">
          {files.length} file{files.length === 1 ? "" : "s"}
        </span>
        <span className="text-xs text-muted-foreground">
          <span className="text-green-600 dark:text-green-400">+{additions}</span>{" "}
          <span className="text-red-600 dark:text-red-400">−{deletions}</span>
        </span>
        <span className="ml-auto text-xs text-muted-foreground" aria-hidden="true">
          {open ? "▼" : "▶"}
        </span>
      </button>
      {open ? (
        <div className="divide-y divide-border border-t border-border p-3">
          {files.map((file) => (
            <FileDiffCard
              key={file.path}
              file={file}
              url={url}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ReviewThreadCard({ thread }: { thread: ReviewThread }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <p className="flex items-center gap-2 border-b border-border bg-muted/50 px-3 py-1.5 font-mono text-xs text-muted-foreground">
        <span className="min-w-0 truncate">{thread.path}</span>
        {thread.line !== null ? (
          <span className="shrink-0">:{thread.line}</span>
        ) : null}
      </p>
      {thread.diffHunk.length > 0 ? (
        <div className="border-b border-border">
          <Diff patch={thread.diffHunk} path={thread.path} />
        </div>
      ) : null}
      <div className="flex flex-col gap-3 p-3">
        {thread.comments.map((entry, index) => (
          <div key={index}>
            <p className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
              <Avatar login={entry.author} size="size-4" />
              <span className="font-medium text-foreground">
                {entry.author}
              </span>{" "}
              · {relativeTime(entry.createdAt)}
            </p>
            <Markdown content={entry.body} className="text-sm" />
          </div>
        ))}
      </div>
    </div>
  );
}

type PullTimelineEntry =
  | { type: "comment"; author: string; body: string; createdAt: string }
  | {
      type: "review";
      author: string;
      state: string;
      body: string;
      createdAt: string;
    };

function PullTimeline({ pull }: { pull: PullDetail }) {
  const entries = useMemo<PullTimelineEntry[]>(() => {
    const merged: PullTimelineEntry[] = [
      ...pull.comments.map((comment) => ({
        type: "comment" as const,
        ...comment,
      })),
      ...pull.reviews
        .filter(
          (review) => review.body.length > 0 || review.state !== "COMMENTED",
        )
        .map((review) => ({ type: "review" as const, ...review })),
    ];
    return merged.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }, [pull]);
  if (entries.length === 0 && pull.reviewThreads.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold text-muted-foreground">
        Activity · {entries.length + pull.reviewThreads.length}
      </h3>
      {entries.map((entry, index) => (
        <div
          key={index}
          className="rounded-lg border border-border bg-card p-3"
        >
          <p className="mb-1.5 flex items-center gap-2 text-xs text-muted-foreground">
            <Avatar login={entry.author} />
            <span className="font-medium text-foreground">{entry.author}</span>
            {entry.type === "review" ? (
              <span className={`font-medium ${reviewStateClass(entry.state)}`}>
                {REVIEW_STATE_LABELS[entry.state] ?? entry.state.toLowerCase()}
              </span>
            ) : null}
            · {relativeTime(entry.createdAt)}
          </p>
          {entry.body.length > 0 ? (
            <Markdown content={entry.body} className="text-sm" />
          ) : null}
        </div>
      ))}
      {pull.reviewThreads.map((thread, index) => (
        <ReviewThreadCard key={index} thread={thread} />
      ))}
    </div>
  );
}

function PullReviewersList({ pull }: { pull: PullDetail }) {
  const rows = useMemo(() => {
    const latest = new Map<string, { login: string; state: string }>();
    for (const review of pull.reviews) {
      if (review.author.length > 0) {
        latest.set(review.author, {
          login: review.author,
          state: review.state,
        });
      }
    }
    for (const login of pull.reviewRequests) {
      latest.set(login, { login, state: "PENDING" });
    }
    return [...latest.values()];
  }, [pull]);
  if (rows.length === 0)
    return <p className="text-sm text-muted-foreground">No reviewers</p>;
  return (
    <>
      {rows.map((row) => (
        <p
          key={row.login}
          className="flex items-center gap-2 text-sm text-foreground"
        >
          <Avatar login={row.login} />
          <span className="min-w-0 truncate">{row.login}</span>
          <span
            className={`ml-auto shrink-0 text-xs ${reviewStateClass(row.state)}`}
          >
            {REVIEW_STATE_LABELS[row.state] ?? row.state.toLowerCase()}
          </span>
        </p>
      ))}
    </>
  );
}

function PullCommentBox({
  repo,
  number,
  onPosted,
}: {
  repo: string;
  number: number;
  onPosted: () => void;
}) {
  const rpc = useRpc<typeof githubRpcContract>();
  const [comment, setComment] = useState("");
  const [posting, setPosting] = useState(false);
  const post = useCallback(() => {
    if (comment.trim().length === 0) return;
    setPosting(true);
    rpc
      .call("commentPull", { repo, number, body: comment })
      .then(() => {
        setComment("");
        onPosted();
      })
      .catch((error: unknown) => toast.error(errorText(error)))
      .finally(() => setPosting(false));
  }, [rpc, repo, number, comment, onPosted]);
  return (
    <div className="flex flex-col gap-2">
      <Textarea
        value={comment}
        onChange={(event) => setComment(event.target.value)}
        placeholder="Leave a comment…"
        rows={3}
      />
      <div className="flex justify-end">
        <Button
          size="sm"
          className="gap-1.5"
          disabled={posting || comment.trim().length === 0}
          aria-busy={posting}
          onClick={post}
        >
          {posting ? <Spinner className="size-3" /> : null}
          {posting ? "Posting…" : "Comment"}
        </Button>
      </div>
    </div>
  );
}

function PullDetailView({
  repo,
  number,
  onBack,
  backLabel = "Pull requests",
  compact = false,
}: {
  repo: string;
  number: number;
  onBack?: () => void;
  backLabel?: string;
  compact?: boolean;
}) {
  const rpc = useRpc<typeof githubRpcContract>();
  const { links, error: linksError, refetch: retryLinks } = useLinks();
  const { spawn, spawningKey } = useSpawn();
  const [pull, setPull] = useState<PullDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const detailKey = `${repo}#${number}`;
  const activeDetailKey = useRef(detailKey);
  activeDetailKey.current = detailKey;
  const loadRequest = useRef(0);

  const load = useCallback(() => {
    const requestId = ++loadRequest.current;
    const requestKey = detailKey;
    setLoading(true);
    rpc.call("getPull", { repo, number }).then(
      (result) => {
        if (requestId !== loadRequest.current || activeDetailKey.current !== requestKey) return;
        const detail = (result as { pull?: PullDetail })?.pull;
        if (detail === undefined || detail === null) {
          setPull(null);
          setError("malformed getPull result");
          setLoading(false);
          return;
        }
        setPull(detail);
        setError(null);
        setLoading(false);
      },
      (err: unknown) => {
        if (requestId === loadRequest.current && activeDetailKey.current === requestKey) {
          setError(errorText(err));
          setLoading(false);
        }
      },
    );
  }, [rpc, repo, number, detailKey]);
  useEffect(() => {
    setPull(null);
    setError(null);
    setLoading(true);
    load();
    return () => {
      loadRequest.current += 1;
    };
  }, [load]);

  if (pull === null && error !== null) {
    return (
      <EmptyState
        title="Couldn't load pull request"
        message={error}
        onRetry={load}
      />
    );
  }
  if (pull === null) {
    return <DetailSkeleton label="Loading pull request" compact={compact} />;
  }

  const pullLinks = links[`pr:${repo}#${number}`];
  const mainColumn = (
    <div className="flex min-w-0 flex-1 flex-col gap-4">
      <ChecksSection checks={pull.checks} />

      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="flex items-center gap-2 border-b border-border bg-muted/50 px-4 py-2 text-xs text-muted-foreground">
          <Avatar login={pull.author} />
          <span className="font-medium text-foreground">{pull.author}</span>
          opened this pull request · updated {relativeTime(pull.updatedAt)}
        </div>
        <div className="p-4">
          {pull.body.length > 0 ? (
            <Markdown content={pull.body} className="text-sm" />
          ) : (
            <p className="text-sm text-muted-foreground">(no description)</p>
          )}
        </div>
      </div>

      <PullTimeline pull={pull} />

      <FilesChangedSection
        files={pull.files}
        url={pull.url}
        additions={pull.additions}
        deletions={pull.deletions}
      />

      <PullCommentBox repo={repo} number={number} onPosted={load} />
    </div>
  );

  return (
    <div className="flex flex-col gap-4" aria-busy={loading}>
      {loading ? <RefreshBar visible /> : null}
      {error !== null ? (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-xs text-red-600 dark:text-red-400"
        >
          <span>Could not refresh this pull request: {error}</span>
          <Button size="sm" variant="outline" className="h-7 shrink-0" onClick={load}>
            Retry
          </Button>
        </div>
      ) : null}
      <LinkErrorNotice error={linksError} onRetry={retryLinks} />
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        {onBack !== undefined ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2"
            onClick={onBack}
          >
            ← {backLabel}
          </Button>
        ) : null}
        <span className="min-w-0 truncate">
          {repo} · #{number}
        </span>
        <span className="flex-1" />
        <SafeUrlLink
          href={pull.url}
          className="shrink-0 underline hover:text-foreground"
        >
          Open on GitHub ↗
        </SafeUrlLink>
      </div>

      <div className="flex items-start gap-3">
        <h2
          className={`min-w-0 flex-1 font-semibold text-foreground ${compact ? "text-base" : "text-xl"}`}
        >
          {pull.title}{" "}
          <span className="font-normal text-muted-foreground">
            #{pull.number}
          </span>
        </h2>
        <Button
          size="sm"
          className="gap-1.5"
          disabled={spawningKey !== null}
          aria-busy={spawningKey !== null}
          onClick={() => spawn("startReview", repo, number)}
        >
          {spawningKey !== null ? <Spinner className="size-3" /> : null}
          {spawningKey !== null ? "Starting…" : "Review with agent"}
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <PullStateBadge state={pull.state} />
        <ReviewDecisionBadge decision={pull.reviewDecision} />
        <span className="font-mono">
          {pull.baseRefName} ← {pull.headRefName}
        </span>
        <span>
          <span className="text-green-600 dark:text-green-400">
            +{pull.additions}
          </span>{" "}
          <span className="text-red-600 dark:text-red-400">
            −{pull.deletions}
          </span>{" "}
          · {pull.changedFiles} file{pull.changedFiles === 1 ? "" : "s"}
        </span>
        <LabelChips labels={pull.labels} className="flex flex-wrap" />
        <ThreadPills links={pullLinks} />
      </div>

      {compact ? (
        mainColumn
      ) : (
        <div className="flex flex-col gap-6 lg:flex-row">
          {mainColumn}
          <aside className="flex w-full shrink-0 flex-col gap-5 lg:w-56">
            <div className="flex flex-col gap-1">
              <SidebarHeading>Reviewers</SidebarHeading>
              <PullReviewersList pull={pull} />
            </div>
            <div className="flex flex-col gap-1">
              <SidebarHeading>Assignees</SidebarHeading>
              {pull.assignees.length === 0 ? (
                <p className="text-sm text-muted-foreground">No one assigned</p>
              ) : (
                pull.assignees.map((login) => (
                  <p
                    key={login}
                    className="flex items-center gap-2 text-sm text-foreground"
                  >
                    <Avatar login={login} />
                    <span className="truncate">{login}</span>
                  </p>
                ))
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <SidebarHeading>Labels</SidebarHeading>
              {pull.labels.length === 0 ? (
                <p className="text-sm text-muted-foreground">None yet</p>
              ) : (
                <LabelChips labels={pull.labels} className="flex flex-wrap" />
              )}
            </div>
            {pullLinks !== undefined && pullLinks.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                <SidebarHeading>Agents</SidebarHeading>
                <ThreadPills links={pullLinks} />
              </div>
            ) : null}
          </aside>
        </div>
      )}
    </div>
  );
}

function PullPickerList({
  onPick,
  disabled = false,
}: {
  onPick: (repo: string, number: number) => void;
  disabled?: boolean;
}) {
  const { items, error, loading, refetch } = useItems("pr");
  if (error !== null && items === null) {
    return (
      <EmptyState
        title="Couldn't load pull requests"
        message={error}
        onRetry={refetch}
      />
    );
  }
  if (items === null) {
    return (
      <div
        role="status"
        aria-live="polite"
        aria-busy="true"
        aria-label="Loading pull requests"
        className="flex flex-col gap-2"
      >
        <span className="sr-only">Loading pull requests</span>
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-5/6" />
        <Skeleton className="h-9 w-2/3" />
      </div>
    );
  }
  const open = items.filter((item) => item.state === "OPEN");
  if (open.length === 0) {
    return (
      <EmptyState
        title="No open pull requests"
        message="No open pull requests in the tracked repos."
      />
    );
  }
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card" aria-busy={loading}>
      {loading ? (
        <>
          <span className="sr-only">Updating pull requests</span>
          <RefreshBar visible />
        </>
      ) : null}
      <div className="divide-y divide-border">
        {open.map((item) => (
          <button
            key={`${item.repo}#${item.number}`}
            type="button"
            disabled={disabled}
            className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent/50 disabled:pointer-events-none disabled:opacity-50"
            onClick={() => onPick(item.repo, item.number)}
          >
            <StateDot kind="pr" state={item.state} />
            <span className="shrink-0 font-mono text-xs text-muted-foreground">
              #{item.number}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm text-foreground">
              {item.title}
            </span>
            <span className="hidden shrink-0 text-xs text-muted-foreground sm:block">
              {item.repo}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function PullPanelTab({ threadId }: PluginThreadPanelProps) {
  const rpc = useRpc<typeof githubRpcContract>();
  const activeThreadId = useRef(threadId);
  activeThreadId.current = threadId;
  const [resolved, setResolved] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const [selected, setSelected] = useState<{
    repo: string;
    number: number;
  } | null>(null);
  const resolveRequest = useRef(0);
  const linkRequest = useRef(0);

  const resolve = useCallback(() => {
    const requestId = ++resolveRequest.current;
    const requestThreadId = threadId;
    setResolved(false);
    setResolveError(null);
    setLinkError(null);
    setSelected(null);
    rpc.call("pullForThread", { threadId: requestThreadId }).then(
      (result) => {
        if (
          requestId !== resolveRequest.current ||
          activeThreadId.current !== requestThreadId
        ) {
          return;
        }
        const pull = (
          result as {
            pull?: {
              repo?: unknown;
              number?: unknown;
            } | null;
          }
        )?.pull;
        if (
          pull &&
          typeof pull.repo === "string" &&
          typeof pull.number === "number"
        ) {
          setSelected({
            repo: pull.repo,
            number: pull.number,
          });
        }
        setResolved(true);
      },
      (reason: unknown) => {
        if (
          requestId !== resolveRequest.current ||
          activeThreadId.current !== requestThreadId
        ) {
          return;
        }
        setResolveError(errorText(reason));
        setResolved(true);
      },
    );
  }, [rpc, threadId]);

  useEffect(() => {
    linkRequest.current += 1;
    setLinking(false);
    resolve();
    return () => {
      resolveRequest.current += 1;
      linkRequest.current += 1;
    };
  }, [resolve]);

  const pick = useCallback(
    (repo: string, number: number) => {
      if (linking) return;
      const requestId = ++linkRequest.current;
      const requestThreadId = threadId;
      setLinking(true);
      setLinkError(null);
      rpc.call("linkPullToThread", { threadId: requestThreadId, repo, number }).then(
        () => {
          if (requestId === linkRequest.current && activeThreadId.current === requestThreadId) {
            setSelected({ repo, number });
          }
        },
        (reason: unknown) => {
          if (requestId === linkRequest.current && activeThreadId.current === requestThreadId) {
            setLinkError(errorText(reason));
          }
        },
      ).finally(() => {
        if (requestId === linkRequest.current && activeThreadId.current === requestThreadId) {
          setLinking(false);
        }
      });
    },
    [rpc, threadId, linking],
  );

  if (!resolved) {
    return <DetailSkeleton label="Loading linked pull request" compact />;
  }
  if (selected === null) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-xs text-muted-foreground">
          No pull request is linked to this thread yet — pick one:
        </p>
        {resolveError !== null ? (
          <div role="alert" className="flex items-center gap-2 text-xs text-red-500">
            <span>Could not check the linked pull request: {resolveError}</span>
            <Button size="sm" variant="outline" className="h-7 shrink-0" onClick={resolve}>
              Retry lookup
            </Button>
          </div>
        ) : null}
        {linkError !== null ? (
          <p role="alert" className="text-xs text-red-500">
            Could not link this pull request: {linkError}
          </p>
        ) : null}
        {linking ? (
          <p role="status" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <Spinner className="size-3" />
            Linking pull request…
          </p>
        ) : null}
        <PullPickerList onPick={pick} disabled={linking} />
      </div>
    );
  }
  return (
    <PullDetailView
      repo={selected.repo}
      number={selected.number}
      compact
      backLabel="All PRs"
      onBack={() => setSelected(null)}
    />
  );
}

function NewIssueForm({
  repos,
  onCreated,
  onCancel,
}: {
  repos: RepoInfo[];
  onCreated: (repo: string, number: number | null) => void;
  onCancel: () => void;
}) {
  const rpc = useRpc<typeof githubRpcContract>();
  const [repo, setRepo] = useState(repos[0]?.repo ?? "");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (repo.length === 0 && repos[0]) setRepo(repos[0].repo);
  }, [repo, repos]);

  const create = useCallback(() => {
    const trimmedTitle = title.trim();
    if (repo.length === 0 || trimmedTitle.length === 0) {
      setFormError(
        repo.length === 0
          ? "Select a repository to continue."
          : "Add a title to continue.",
      );
      return;
    }
    setFormError(null);
    setCreating(true);
    rpc
      .call("createIssue", { repo, title: trimmedTitle, body })
      .then((result) => {
        const number = (result as { number?: unknown })?.number;
        toast.success("Issue created");
        onCreated(repo, typeof number === "number" ? number : null);
      })
      .catch((err: unknown) => toast.error(errorText(err)))
      .finally(() => setCreating(false));
  }, [rpc, repo, title, body, onCreated]);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <div className="flex items-start gap-3">
        <Button size="sm" variant="ghost" className="h-8 shrink-0 px-2" onClick={onCancel} aria-label="Back to issues">
          ← Issues
        </Button>
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-foreground">New issue</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">Create an issue in one of your tracked repositories.</p>
        </div>
      </div>
      <form
        className="overflow-hidden rounded-xl border border-border bg-card shadow-sm"
        onSubmit={(event) => {
          event.preventDefault();
          create();
        }}
      >
        <div className="border-b border-border bg-muted/50 px-4 py-3 md:px-5">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Issue details</p>
          <p className="mt-1 text-sm text-muted-foreground">Add enough context for someone else to understand and act on the problem.</p>
        </div>
        <div className="flex flex-col gap-5 p-4 md:p-5">
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor="github-new-issue-repo" className="text-sm font-medium text-foreground">Repository</label>
              <span className="text-xs text-muted-foreground">{repos.length} tracked</span>
            </div>
            <Select value={repo} onValueChange={setRepo}>
              <SelectTrigger id="github-new-issue-repo" className="h-10 w-full">
                <SelectValue placeholder="Select a repository" />
              </SelectTrigger>
              <SelectContent>
                {repos.map((entry) => <SelectItem key={entry.repo} value={entry.repo}>{entry.repo}</SelectItem>)}
              </SelectContent>
            </Select>
            <p id="github-new-issue-repo-help" className="text-xs text-muted-foreground">The issue will be created in this repository.</p>
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor="github-new-issue-title" className="text-sm font-medium text-foreground">Title</label>
              <span className="text-xs text-muted-foreground">{title.length} characters</span>
            </div>
            <Input
              id="github-new-issue-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Summarize the issue"
              autoComplete="off"
              required
              aria-describedby="github-new-issue-title-help"
              aria-invalid={title.length > 0 && title.trim().length === 0}
              className="h-10 rounded-lg px-3 py-2"
            />
            <p id="github-new-issue-title-help" className="text-xs text-muted-foreground">Keep it short and specific so it is easy to scan in the issue list.</p>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="github-new-issue-description" className="text-sm font-medium text-foreground">Description</label>
            <Textarea
              id="github-new-issue-description"
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder="What happened? Include steps to reproduce, expected behavior, and any useful context."
              rows={10}
              aria-describedby="github-new-issue-description-help"
              className="min-h-48 resize-y rounded-lg leading-snug"
            />
            <p id="github-new-issue-description-help" className="text-xs text-muted-foreground">Markdown is supported. You can add more detail after the issue is created.</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3 md:px-5">
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">
              {repo.length === 0 ? "Select a repository to continue." : title.trim().length === 0 ? "Add a title to continue." : "Ready to create this issue."}
            </p>
            {formError !== null ? <p role="alert" className="mt-0.5 max-w-md text-xs text-red-500">{formError}</p> : null}
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={creating}>Cancel</Button>
            <Button type="submit" size="sm" className="gap-1.5" disabled={creating || title.trim().length === 0 || repo.length === 0} aria-busy={creating}>
              {creating ? <Spinner className="size-3" /> : null}
              {creating ? "Creating…" : "Create issue"}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}

type Status = GithubStatus;

function useStatus(): {
  status: Status | null;
  error: string | null;
  loading: boolean;
  refetch: () => void;
} {
  const rpc = useRpc<typeof githubRpcContract>();
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const requestVersion = useRef(0);
  const refetch = useCallback(() => {
    const version = ++requestVersion.current;
    setLoading(true);
    setError(null);
    rpc.call("status").then(
      (result) => {
        if (version !== requestVersion.current) return;
        const next = normalizeStatus(result);
        if (next === null) {
          setStatus(null);
          setError("GitHub status response was invalid.");
          setLoading(false);
          return;
        }
        setStatus(next);
        setError(null);
        setLoading(false);
      },
      (reason: unknown) => {
        if (version !== requestVersion.current) return;
        setError(errorText(reason));
        setLoading(false);
      },
    );
  }, [rpc]);
  useEffect(() => {
    refetch();
    return () => {
      requestVersion.current += 1;
    };
  }, [refetch]);
  useRealtime("data-changed", refetch);
  return { status, error, loading, refetch };
}

function PanelHeader() {
  const rpc = useRpc<typeof githubRpcContract>();
  const { status, error: statusError, loading } = useStatus();
  const [syncing, setSyncing] = useState(false);
  const [failed, setFailed] = useState(false);
  const refresh = useCallback(() => {
    setSyncing(true);
    setFailed(false);
    rpc
      .call("refresh")
      .catch(() => setFailed(true))
      .finally(() => setSyncing(false));
  }, [rpc]);
  const busy = syncing || (loading && status === null);
  return (
    <>
      <span className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:inline-flex">
        {failed ? (
          "Sync failed — check `gh auth status`"
        ) : status === null && statusError !== null ? (
          "GitHub status unavailable — retry"
        ) : status === null ? (
          <>
            <Spinner className="size-3" />
            Checking GitHub…
          </>
        ) : status.ghOk ? (
          <>
            {syncing ? <Spinner className="size-3" /> : null}
            {`${status.repos.length} repo${status.repos.length === 1 ? "" : "s"} · synced ${
              status.lastSyncedAt !== null
                ? relativeTime(status.lastSyncedAt)
                : "never"
            }`}
          </>
        ) : status.ghState === "unavailable" ? (
          "GitHub CLI unavailable — retrying"
        ) : (
          "GitHub CLI not authenticated"
        )}
      </span>
      <Button
        size="sm"
        variant="outline"
        className="size-8 gap-1.5 px-0 sm:h-8 sm:w-auto sm:px-3"
        disabled={syncing}
        aria-busy={busy}
        onClick={refresh}
        aria-label={syncing ? "Syncing GitHub data" : statusError !== null ? "Retry GitHub status" : "Refresh GitHub data"}
      >
        <RefreshIcon className={syncing ? "animate-spin" : undefined} />
        <span className="hidden sm:inline">
          {syncing ? "Syncing…" : "Refresh"}
        </span>
      </Button>
    </>
  );
}

function tabForRoute(route: Route): SavedViewTab {
  return route.view === "pulls"
    ? "pulls"
    : route.view === "dependabot" || route.view === "dependabot-alert"
      ? "dependabot"
      : "issues";
}

function GithubPanel({ subPath }: PluginNavPanelProps) {
  const [route, navigate] = useSubPathRoute(subPath);
  const { status, error: statusError, loading: statusLoading, refetch: retryStatus } = useStatus();
  const [queries, setQueries] = useState<QueryState>(() =>
    loadQueryState(window.localStorage),
  );
  const tab = tabForRoute(route);
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (
        event.key === QUERY_STATE_KEY ||
        event.key === LEGACY_QUERY_KEY
      ) {
        setQueries(loadQueryState(window.localStorage));
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  const setQuery = useCallback((next: string) => {
    setQueries((previous) => {
      const updated = { ...previous, [tab]: next };
      try {
        saveQueryState(window.localStorage, updated, tab);
      } catch {}
      return updated;
    });
  }, [tab]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-5">
      <div className="mx-auto w-full max-w-5xl space-y-4">
        {statusError !== null && status === null ? (
          <div role="alert" className="rounded-lg border border-border bg-card">
            <EmptyState
              title="Couldn't load GitHub status"
              message={`Could not load GitHub status: ${statusError}`}
            />
            <div className="flex justify-center border-t border-border px-6 py-3">
              <Button size="sm" variant="outline" onClick={retryStatus}>
                Retry GitHub status
              </Button>
            </div>
          </div>
        ) : (
          <>
            {statusError !== null ? (
              <div
                role="alert"
                className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2 text-xs text-red-600 dark:text-red-400"
              >
                <span>Could not refresh GitHub status: {statusError}</span>
                <Button size="sm" variant="outline" className="h-7 shrink-0" onClick={retryStatus}>
                  Retry GitHub status
                </Button>
              </div>
            ) : null}
            <GithubPanelBody
              route={route}
              navigate={navigate}
              status={status}
              loading={statusLoading}
              query={queries[tab]}
              setQuery={setQuery}
              onRetryStatus={retryStatus}
            />
          </>
        )}
      </div>
    </div>
  );
}

function SavedViewsBar({
  tab,
  query,
  onChange,
}: {
  tab: SavedViewTab;
  query: string;
  onChange: (query: string) => void;
}) {
  const [views, setViews] = useState<SavedViews>(() => {
    try {
      return loadSavedViews(window.localStorage);
    } catch {
      return { issues: [], pulls: [], dependabot: [] };
    }
  });
  const [name, setName] = useState("");
  const [editing, setEditing] = useState(false);
  const current = views[tab];
  const selected = current.find((view) => view.query === query)?.name ?? "";

  useEffect(() => {
    setEditing(false);
    setName("");
  }, [tab]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === SAVED_VIEWS_KEY) {
        setViews(loadSavedViews(window.localStorage));
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const persist = (next: SavedViews) => {
    setViews(next);
    saveSavedViews(window.localStorage, next);
  };

  if (current.length === 0 && query.trim().length === 0 && !editing) {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Saved views">
      {current.map((view) => {
        const active = view.name === selected;
        return (
          <span
            key={view.name}
            className={cn(
              "inline-flex h-7 max-w-full items-center rounded-full border text-xs transition-colors",
              active
                ? "border-foreground bg-foreground text-background"
                : "border-border bg-background text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            <button
              type="button"
              aria-pressed={active}
              className="inline-flex min-w-0 items-center truncate rounded-full px-2.5 py-0"
              onClick={() => onChange(active ? "" : view.query)}
            >
              {view.name}
            </button>
            {active ? (
              <button
                type="button"
                className="mr-1 inline-flex size-4 shrink-0 items-center justify-center rounded-full text-[11px] opacity-80 hover:bg-background/20 hover:opacity-100"
                aria-label={`Delete ${view.name}`}
                onClick={() => persist(deleteSavedView(views, tab, view.name))}
              >
                ×
              </button>
            ) : null}
          </span>
        );
      })}
      {editing ? (
        <form
          className="flex items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim().length === 0) return;
            persist(upsertSavedView(views, tab, name, query));
            setName("");
            setEditing(false);
          }}
        >
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="View name"
            aria-label="Saved view name"
            className="h-7 w-36 text-xs"
            autoFocus
          />
          <Button type="submit" size="sm" variant="outline" className="h-7" disabled={name.trim().length === 0}>
            Save
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7"
            onClick={() => {
              setEditing(false);
              setName("");
            }}
          >
            Cancel
          </Button>
        </form>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs text-muted-foreground"
          disabled={query.trim().length === 0 || selected !== ""}
          onClick={() => setEditing(true)}
        >
          Save view
        </Button>
      )}
    </div>
  );
}


function repoHealthText(health: RepoHealth): string {
  if (health.status === "syncing") return "syncing";
  if (health.status === "never") return "not synced";
  if (health.status === "healthy") return "healthy";
  if (health.status === "partial") return "partial";
  return "failed";
}

function AddRepositoryForm() {
  const rpc = useRpc<typeof githubRpcContract>();
  const [value, setValue] = useState("");
  const [adding, setAdding] = useState(false);
  const submit = useCallback(
    (event: React.SyntheticEvent<HTMLFormElement>) => {
      event.preventDefault();
      const repo = value.trim();
      if (repo.length === 0 || adding) return;
      setAdding(true);
      rpc
        .call("addRepository", { repo })
        .then(() => {
          toast.success("Added " + repo);
          setValue("");
        })
        .catch((error: unknown) => toast.error(errorText(error)))
        .finally(() => setAdding(false));
    },
    [rpc, value, adding],
  );
  return (
    <form
      className="flex flex-col gap-2 border-b border-border p-3 @[48rem]:flex-row @[48rem]:items-center"
      onSubmit={submit}
    >
      <label htmlFor="github-add-repository" className="sr-only">
        Repository
      </label>
      <Input
        id="github-add-repository"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="Add owner/repository"
        autoComplete="off"
        disabled={adding}
        className="h-9"
      />
      <Button size="sm" type="submit" className="h-9 gap-1.5 @[48rem]:shrink-0" disabled={adding || value.trim().length === 0} aria-busy={adding}>
        {adding ? <Spinner className="size-3" /> : null}
        {adding ? "Adding…" : "Add"}
      </Button>
    </form>
  );
}

function RepositoryManager({
  status,
  onSelectRepo,
}: {
  status: Status;
  onSelectRepo?: (repo: string) => void;
}) {
  const rpc = useRpc<typeof githubRpcContract>();
  const [busy, setBusy] = useState<string | null>(null);
  const [summary, setSummary] = useState<{
    items: Item[];
    alerts: DependabotAlert[];
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const reposKey = status.repos.map((entry) => entry.repo).join("\u0000");
  const activeReposKey = useRef(reposKey);
  activeReposKey.current = reposKey;
  const repoEntriesRef = useRef(status.repos);
  repoEntriesRef.current = status.repos;

  const load = useCallback(() => {
    const requestId = ++requestRef.current;
    const requestKey = reposKey;
    const repos = repoEntriesRef.current.map((entry) => entry.repo);
    if (repos.length === 0) {
      setSummary({ items: [], alerts: [] });
      setLoadError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    Promise.all([
      rpc.call("listItems", {}),
      rpc.call("listDependabotAlerts", { repos }),
    ]).then(
      ([itemsResult, alertsResult]) => {
        if (requestId !== requestRef.current || requestKey !== activeReposKey.current) return;
        setSummary({
          items: asItems(itemsResult),
          alerts: Array.isArray((alertsResult as { alerts?: unknown })?.alerts)
            ? ((alertsResult as { alerts: DependabotAlert[] }).alerts)
            : [],
        });
        setLoadError(null);
        setLoading(false);
      },
      (reason: unknown) => {
        if (requestId === requestRef.current && requestKey === activeReposKey.current) {
          setLoadError(errorText(reason));
          setLoading(false);
        }
      },
    );
  }, [rpc, reposKey]);

  useEffect(() => {
    setLoadError(null);
    load();
    return () => {
      requestRef.current += 1;
    };
  }, [load]);
  useRealtime("data-changed", load);

  const run = (repo: string, action: () => Promise<unknown>) => {
    setBusy(repo);
    action()
      .then(() => {
        toast.success(repo + " updated");
        load();
      })
      .catch((error: unknown) => toast.error(errorText(error)))
      .finally(() => setBusy(null));
  };

  return (
    <div aria-busy={loading || busy !== null}>
      {loading && summary !== null ? (
        <>
          <span className="sr-only">Updating repositories</span>
          <RefreshBar visible />
        </>
      ) : null}
      {loadError !== null ? (
        <EmptyState
          title="Couldn't load repository details"
          message={`Could not load repository details: ${loadError}`}
          onRetry={load}
        />
      ) : null}
      {status.repos.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          No repositories yet. Add an owner/repo above or attach a BB project with a GitHub origin.
        </p>
      ) : (
        <div className="divide-y divide-border">
          {status.repos.map((entry) => {
            const health = entry.health;
            const items = summary?.items.filter((item) => item.repo === entry.repo) ?? [];
            const alertCount = summary === null
              ? health.alertCount
              : summary.alerts.filter((alert) => alert.repo === entry.repo && alert.state.toLowerCase() === "open").length;
            const dot = repoHealthDotClass(health.status);
            const dependabotError = health.error !== null && health.error.startsWith("Dependabot:")
              ? health.error
              : null;
            return (
              <div key={entry.repo} className="flex flex-col gap-3 px-4 py-3 transition-colors hover:bg-accent/50 @[48rem]:flex-row @[48rem]:items-center">
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className={"size-2 shrink-0 rounded-full " + dot} title={repoHealthText(health)} aria-hidden="true" />
                    {onSelectRepo !== undefined ? (
                      <button type="button" className="min-w-0 truncate text-left text-sm font-medium text-foreground hover:underline" aria-label={`Filter by ${entry.repo}`} onClick={() => onSelectRepo(entry.repo)}>
                        {entry.repo}
                      </button>
                    ) : <span className="min-w-0 truncate text-sm font-medium text-foreground">{entry.repo}</span>}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {entry.projectId !== null ? "Connected to a BB project" : "Added manually"} · {repoHealthText(health)}
                  </p>
                  {dependabotError !== null ? (
                    <DependabotSyncErrorNotice compact repo={entry.repo} message={dependabotError} />
                  ) : health.error !== null ? (
                    <p className="mt-1 truncate text-xs text-red-600 dark:text-red-400" title={health.error}>{health.error}</p>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-2 @[48rem]:flex-nowrap">
                  {[[items.filter((item) => item.kind === "issue" && item.state === "OPEN").length, "Issues"], [items.filter((item) => item.kind === "pr" && item.state === "OPEN").length, "PRs"], [alertCount, "Alerts"]].map(([count, label]) => (
                    <div key={label} className="min-w-0 flex-1 rounded-md border border-border bg-muted/50 px-2 py-1.5 text-center">
                      <span className="block text-sm font-medium text-foreground">
                        {summary === null ? (loading ? <Skeleton className="mx-auto h-4 w-6" /> : "—") : count}
                      </span>
                      <span className="block truncate text-[11px] text-muted-foreground">{label}</span>
                    </div>
                  ))}
                </div>
                <div className="flex shrink-0 items-center justify-end gap-1">
                  <Button size="sm" variant="ghost" className="h-8 gap-1.5 px-2" disabled={busy !== null} aria-busy={busy === entry.repo} onClick={() => run(entry.repo, () => rpc.call("refreshRepository", { repo: entry.repo }))} aria-label={`Refresh ${entry.repo}`} title={`Refresh ${entry.repo}`}>
                    {busy === entry.repo ? <Spinner className="size-3" /> : null}
                    {busy === entry.repo ? "Syncing…" : "Refresh"}
                  </Button>
                  {entry.projectId === null ? (
                    <Button size="sm" variant="ghost" className="h-8 px-2 text-red-500" disabled={busy !== null} onClick={() => { if (window.confirm(`Stop tracking ${entry.repo}? Cached GitHub data will be removed.`)) run(entry.repo, () => rpc.call("removeRepository", { repo: entry.repo })); }}>
                      Remove
                    </Button>
                  ) : <span className="px-2 text-xs text-muted-foreground">Project</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function repoHealthSummary(status: Status | null): string {
  if (status === null) return "not synced";
  return summarizeRepoHealth(status.repos.map((entry) => entry.health.status));
}

function RepoHealthDots({ status }: { status: Status | null }) {
  const groups =
    status === null || status.repos.length === 0
      ? [{ tone: "muted" as const, count: 0 }]
      : repoHealthColorCounts(status.repos.map((entry) => entry.health.status));
  return (
    <span className="flex items-center gap-1.5" aria-hidden="true">
      {groups.map((group) => (
        <span key={group.tone} className="inline-flex items-center gap-1">
          <span
            className={
              "size-2 rounded-full " +
              repoHealthDotClass(
                group.tone === "muted"
                  ? "never"
                  : group.tone === "healthy"
                    ? "healthy"
                    : group.tone === "syncing"
                      ? "syncing"
                      : "failed",
              )
            }
          />
          {group.count > 0 ? (
            <span className="text-[11px] font-medium tabular-nums leading-none">
              {group.count}
            </span>
          ) : null}
        </span>
      ))}
    </span>
  );
}

function ReposDrawer({
  status,
  onSelectRepo,
}: {
  status: Status | null;
  onSelectRepo: (repo: string) => void;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between gap-3 border-b border-border bg-muted/50 px-4 py-2.5">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">Tracked repositories</h2>
          <p className="text-xs text-muted-foreground">
            {status === null
              ? "Loading tracked repositories…"
              : status.lastSyncedAt !== null
                ? `Last synced ${relativeTime(status.lastSyncedAt)}`
                : "Not synced yet"}
          </p>
        </div>
        <span className="rounded-full border border-border bg-background px-2 py-0.5 text-xs font-medium text-foreground">
          {status?.repos.length ?? "—"}
        </span>
      </div>
      <AddRepositoryForm />
      {status !== null ? (
        <RepositoryManager status={status} onSelectRepo={onSelectRepo} />
      ) : (
        <RepositoryManagerSkeleton />
      )}
    </section>
  );
}

function DependabotFilter(query: string): {
  repos: string[];
  states: string[];
  severities: string[];
  fix: "yes" | "no" | null;
  text: string[];
} {
  const result: {
    repos: string[];
    states: string[];
    severities: string[];
    fix: "yes" | "no" | null;
    text: string[];
  } = { repos: [], states: [], severities: [], fix: null, text: [] };
  for (const token of query.trim().split(/\s+/).filter(Boolean)) {
    const separator = token.indexOf(":");
    if (separator <= 0) {
      result.text.push(token.toLowerCase());
      continue;
    }
    const key = token.slice(0, separator).toLowerCase();
    const value = token.slice(separator + 1).replace(/"/g, "").toLowerCase();
    if (key === "repo") result.repos.push(value);
    else if (key === "is" || key === "state") result.states.push(value);
    else if (key === "severity") result.severities.push(value);
    else if (key === "fix" || key === "has") {
      if (value === "fix" || value === "yes") result.fix = "yes";
      if (value === "no") result.fix = "no";
    } else {
      result.text.push(token.toLowerCase());
    }
  }
  return result;
}

function severityClass(severity: string): string {
  const normalized = severity.toLowerCase();
  if (normalized === "critical") return "github-severity-critical";
  if (normalized === "high") return "github-severity-high";
  if (normalized === "moderate") return "github-severity-moderate";
  return "github-severity-neutral";
}

function severityDotClass(severity: string): string {
  const normalized = severity.toLowerCase();
  if (normalized === "critical") return "bg-red-500";
  if (normalized === "high") return "bg-orange-500";
  if (normalized === "moderate" || normalized === "medium") return "bg-yellow-500";
  if (normalized === "low") return "bg-green-500";
  return "bg-muted-foreground/50";
}

function DependabotSyncErrorNotice({
  repo,
  message,
  compact = false,
}: {
  repo: string;
  message: string;
  compact?: boolean;
}) {
  const alertsDisabled = /Dependabot alerts are disabled/i.test(message);
  const missingScope = /admin:repo_hook/i.test(message);
  const hasKnownCause = alertsDisabled || missingScope;

  return (
    <div
      role="alert"
      className={
        compact
          ? "github-alert-error mt-1 rounded-md border px-2.5 py-2 text-xs"
          : "github-alert-error rounded-lg border px-3 py-3 text-sm"
      }
    >
      <p className="font-medium text-foreground">
        {alertsDisabled ? "Dependabot alerts are unavailable" : "Could not sync Dependabot alerts"}
      </p>
      {!compact ? <p className="mt-1 text-xs text-muted-foreground">{repo}</p> : null}
      {alertsDisabled ? (
        <p className={compact ? "mt-1 text-muted-foreground" : "mt-2 text-muted-foreground"}>
          {compact
            ? "Enable them in GitHub, then refresh this view."
            : "Dependabot alerts are disabled for this repository. Enable them in GitHub, then refresh this view."}
        </p>
      ) : null}
      {missingScope ? (
        <div className={compact ? "mt-1" : "mt-2"}>
          <p className="text-muted-foreground">
            {compact
              ? "Refresh the GitHub CLI token with this command:"
              : <>GitHub also reports that your CLI token needs the <code className="font-mono text-[11px]">admin:repo_hook</code> scope. Refresh it with:</>}
          </p>
          <code
            className={
              compact
                ? "mt-1 block max-w-full overflow-x-auto whitespace-nowrap rounded-md border border-border bg-background px-2 py-1.5 font-mono text-[11px] text-foreground"
                : "mt-2 block overflow-x-auto whitespace-nowrap rounded-md border border-border bg-background px-2.5 py-2 font-mono text-xs text-foreground"
            }
          >
            gh auth refresh -h github.com -s admin:repo_hook
          </code>
        </div>
      ) : null}
      {!hasKnownCause ? (
        <p className={compact ? "mt-1 text-muted-foreground" : "mt-2 text-muted-foreground"}>
          GitHub returned an error while loading alerts. See technical details below.
        </p>
      ) : null}
      <details className={compact ? "mt-1 text-xs text-muted-foreground" : "mt-2 text-xs text-muted-foreground"}>
        <summary className="cursor-pointer font-medium text-foreground">Technical details</summary>
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-background/60 p-2 font-mono text-[11px]">
          {message}
        </pre>
      </details>
    </div>
  );
}
function DependabotListView({
  query,
  setQuery,
  repos,
  onOpenAlert,
}: {
  query: string;
  setQuery: (query: string) => void;
  repos: RepoStatus[];
  onOpenAlert: (repo: string, number: number) => void;
}) {
  const rpc = useRpc<typeof githubRpcContract>();
  const [result, setResult] = useState<{
    alerts: DependabotAlert[];
    errors: Array<{ repo: string; message: string }>;
    stats: { totalCount: number; highCriticalCount: number; withFixCount: number; withoutFixCount: number };
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const filter = useMemo(() => DependabotFilter(query), [query]);
  const selectedRepos = useMemo(() => {
    if (filter.repos.length === 0) return undefined;
    return repos
      .map((entry) => entry.repo)
      .filter((repo) => filter.repos.includes(repo.toLowerCase()));
  }, [filter.repos, repos]);
  const selectedReposKey = selectedRepos?.join("\u0000") ?? "*";
  const requestRef = useRef(0);
  const activeRequestKey = useRef(selectedReposKey);
  activeRequestKey.current = selectedReposKey;
  const load = useCallback(() => {
    const requestId = ++requestRef.current;
    const requestKey = selectedReposKey;
    setLoading(true);
    rpc.call(
      "listDependabotAlerts",
      selectedRepos === undefined ? {} : { repos: selectedRepos },
    ).then(
      (next) => {
        if (requestId !== requestRef.current || requestKey !== activeRequestKey.current) return;
        setResult(next as typeof result);
        setError(null);
        setLoading(false);
      },
      (reason: unknown) => {
        if (requestId === requestRef.current && requestKey === activeRequestKey.current) {
          setError(errorText(reason));
          setLoading(false);
        }
      },
    );
  }, [rpc, selectedRepos, selectedReposKey]);
  const selectedReposKeyRef = useRef(selectedReposKey);
  useEffect(() => {
    if (selectedReposKeyRef.current !== selectedReposKey) {
      setResult(null);
      selectedReposKeyRef.current = selectedReposKey;
    }
    setError(null);
    load();
    return () => {
      requestRef.current += 1;
    };
  }, [load, selectedReposKey]);
  useRealtime("data-changed", load);

  const alerts = useMemo(() => {
    if (result === null) return null;
    return result.alerts.filter((alert) => {
      if (filter.repos.length > 0 && !filter.repos.includes(alert.repo.toLowerCase())) return false;
      if (filter.states.length > 0 && !filter.states.includes(alert.state.toLowerCase())) return false;
      if (filter.severities.length > 0 && !filter.severities.includes(alert.severity.toLowerCase())) return false;
      if (filter.fix === "yes" && alert.firstPatchedVersion === null) return false;
      if (filter.fix === "no" && alert.firstPatchedVersion !== null) return false;
      const haystack = (alert.repo + " " + alert.packageName + " " + alert.summary + " #" + alert.number).toLowerCase();
      return filter.text.every((term) => haystack.includes(term));
    });
  }, [result, filter]);
  const displayStats = useMemo(() => {
    if (alerts === null) return result?.stats ?? null;
    const withFixCount = alerts.filter((alert) => alert.firstPatchedVersion !== null).length;
    return {
      totalCount: alerts.length,
      highCriticalCount: alerts.filter((alert) => {
        const severity = alert.severity.toLowerCase();
        return severity === "high" || severity === "critical";
      }).length,
      withFixCount,
      withoutFixCount: alerts.length - withFixCount,
    };
  }, [alerts, result?.stats]);
  const [page, setPage] = useState(0);
  const pageSize = 25;
  const pageCount = alerts === null ? 0 : Math.max(1, Math.ceil(alerts.length / pageSize));
  const visiblePage = alerts === null || alerts.length === 0 ? 0 : Math.min(page, pageCount - 1);
  const pageAlerts = alerts === null ? null : alerts.slice(visiblePage * pageSize, (visiblePage + 1) * pageSize);
  useEffect(() => setPage(0), [query]);

  return (
    <div className="flex flex-col gap-3">
      <div className="sticky top-0 z-10 flex flex-col gap-2 bg-background pb-1">
        <FilterBar
          value={query}
          onChange={setQuery}
          items={null}
          repos={repos}
          kind="dependabot"
          placeholder="Filter — repo:owner/name severity:high fix:yes, or plain text"
        />
        <SavedViewsBar tab="dependabot" query={query} onChange={setQuery} />
      </div>
      <div className="github-stats-grid">
        {[
          ["Alerts", displayStats?.totalCount],
          ["High / critical", displayStats?.highCriticalCount],
          ["With fix", displayStats?.withFixCount],
          ["No fix", displayStats?.withoutFixCount],
        ].map(([label, value]) => (
          <div key={String(label)} className="rounded-lg border border-border bg-card px-3 py-2">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="text-lg font-semibold text-foreground">
              {displayStats === null ? <Skeleton className="mt-1 h-6 w-10" /> : value}
            </p>
          </div>
        ))}
      </div>
      {result?.errors.map((entry) => (
        <DependabotSyncErrorNotice key={entry.repo} {...entry} />
      ))}
      <div
        className="@container overflow-hidden rounded-lg border border-border bg-card"
        aria-busy={loading}
      >
        {loading && result !== null ? (
          <>
            <span className="sr-only">Updating Dependabot alerts</span>
            <RefreshBar visible />
          </>
        ) : null}
        {error !== null && result !== null ? (
          <div
            role="alert"
            className="flex items-center justify-between gap-3 border-b border-border px-3 py-2 text-xs text-red-600 dark:text-red-400"
          >
            <span>Could not refresh Dependabot alerts: {error}</span>
            <Button size="sm" variant="outline" className="h-7 shrink-0" onClick={load}>
              Retry
            </Button>
          </div>
        ) : null}
        {error !== null && result === null ? (
          <EmptyState
            title="Couldn't load Dependabot alerts"
            message={error}
            onRetry={load}
          />
        ) : pageAlerts === null ? (
          <TableSkeleton label="Loading Dependabot alerts" />
        ) : pageAlerts.length === 0 ? (
          <EmptyState
            title={query.trim().length > 0 ? "No matches" : "No alerts"}
            message={query.trim().length > 0 ? "No Dependabot alerts match this filter." : "No open Dependabot security alerts found on the tracked repositories."}
            actionLabel={query.trim().length > 0 ? "Clear filter" : undefined}
            onAction={query.trim().length > 0 ? () => setQuery("") : undefined}
          />
        ) : (
          <>
            <div className="hidden items-center gap-3 border-b border-border bg-muted/50 px-3 py-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground @[48rem]:flex">
              <span className="shrink-0 @[48rem]:w-12">ID</span>
              <span className="min-w-0 flex-1">Dependency</span>
              <span className="hidden w-40 shrink-0 @[60rem]:block">Vulnerable range</span>
              <span className="shrink-0 @[48rem]:w-24">Severity</span>
              <span className="shrink-0 @[48rem]:w-24">Fix</span>
              <span className="hidden w-16 shrink-0 text-right @[48rem]:block">Updated</span>
              <span className="ml-auto w-20" />
            </div>
            <div className="divide-y divide-border">
            {pageAlerts.map((alert) => (
              <div
                key={alert.repo + "#" + alert.number}
                className="grid w-full grid-cols-1 gap-y-2 px-3 py-3 text-left transition-colors hover:bg-accent/50 @[48rem]:flex @[48rem]:items-center @[48rem]:gap-3 @[48rem]:py-2"
              >
                <span className="flex items-center gap-2 shrink-0 font-mono text-xs text-muted-foreground @[48rem]:order-1 @[48rem]:w-12">
                  <span className={"size-2 rounded-full " + (alert.state.toLowerCase() === "open" ? "bg-green-500" : "bg-muted-foreground/50")} aria-hidden="true" />
                  #{alert.number}
                </span>
                <button
                  type="button"
                  className="min-w-0 flex-1 bg-transparent p-0 text-left @[48rem]:order-2"
                  aria-label={`View Dependabot alert #${alert.number} for ${alert.repo}`}
                  onClick={() => onOpenAlert(alert.repo, alert.number)}
                >
                  <span className="block line-clamp-2 text-sm font-medium leading-snug text-foreground @[48rem]:line-clamp-1 @[48rem]:leading-normal">
                    {alert.packageName}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {alert.repo} · {alert.ecosystem}{alert.summary ? ` · ${alert.summary}` : ""}
                  </span>
                </button>
                <span className="hidden w-40 shrink-0 truncate text-xs text-muted-foreground @[60rem]:order-3 @[60rem]:block" title={alert.vulnerableVersionRange || undefined}>
                  {alert.vulnerableVersionRange || "—"}
                </span>
                <span className="shrink-0 @[48rem]:order-4 @[48rem]:w-24">
                  <span className={"inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium uppercase " + severityClass(alert.severity)}>
                    <span className={"size-2 rounded-full " + severityDotClass(alert.severity)} aria-hidden="true" />
                    {alert.severity}
                  </span>
                </span>
                <span className="flex items-center gap-1.5 text-xs @[48rem]:order-5 @[48rem]:w-24">
                  <span className={"size-2 shrink-0 rounded-full " + (alert.firstPatchedVersion === null ? "bg-muted-foreground/50" : "bg-green-500")} />
                  <span className={alert.firstPatchedVersion === null ? "text-muted-foreground" : "text-green-600 dark:text-green-400"}>
                    {alert.firstPatchedVersion === null ? "No fix" : "Fix " + alert.firstPatchedVersion}
                  </span>
                </span>
                <span className="hidden shrink-0 text-right text-xs text-muted-foreground @[48rem]:order-6 @[48rem]:block @[48rem]:w-16">
                  {relativeTime(alert.updatedAt)}
                </span>
                <span className="ml-auto flex shrink-0 items-center justify-end @[48rem]:order-7 @[48rem]:w-20">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7"
                    onClick={(event) => {
                      event.stopPropagation();
                      onOpenAlert(alert.repo, alert.number);
                    }}
                    aria-label={`View Dependabot alert #${alert.number}`}
                  >
                    View
                  </Button>
                </span>
              </div>
            ))}
            </div>
            {alerts !== null && alerts.length > 0 ? (
              <PageControls
                page={visiblePage}
                pageSize={pageSize}
                total={alerts.length}
                pageCount={pageCount}
                onPageChange={setPage}
              />
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function DependabotDetailView({
  repo,
  number,
  onBack,
}: {
  repo: string;
  number: number;
  onBack: () => void;
}) {
  const rpc = useRpc<typeof githubRpcContract>();
  const [alert, setAlert] = useState<DependabotAlertDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const detailKey = `${repo}#${number}`;
  const activeDetailKey = useRef(detailKey);
  activeDetailKey.current = detailKey;
  const loadRequest = useRef(0);

  const load = useCallback(() => {
    const requestId = ++loadRequest.current;
    const requestKey = detailKey;
    setLoading(true);
    rpc.call("getDependabotAlert", { repo, number }).then(
      (result) => {
        if (requestId !== loadRequest.current || activeDetailKey.current !== requestKey) return;
        const detail = (result as { alert?: DependabotAlertDetail })?.alert;
        if (detail === undefined || detail === null) {
          setAlert(null);
          setError("malformed getDependabotAlert result");
          setLoading(false);
          return;
        }
        setAlert(detail);
        setError(null);
        setLoading(false);
      },
      (reason: unknown) => {
        if (requestId === loadRequest.current && activeDetailKey.current === requestKey) {
          setError(errorText(reason));
          setLoading(false);
        }
      },
    );
  }, [rpc, repo, number, detailKey]);
  useEffect(() => {
    setAlert(null);
    setError(null);
    setLoading(true);
    load();
    return () => {
      loadRequest.current += 1;
    };
  }, [load]);

  if (alert === null && error !== null) {
    return (
      <EmptyState
        title="Couldn't load Dependabot alert"
        message={error}
        onRetry={load}
      />
    );
  }
  if (alert === null) return <DetailSkeleton label="Loading Dependabot alert" />;

  const patchedVersion =
    alert.vulnerabilities.find((entry) => entry.firstPatchedVersion !== null)
      ?.firstPatchedVersion ?? alert.firstPatchedVersion;
  const advisorySeverity = alert.advisorySeverity || alert.severity;
  const epss =
    alert.epss.percentage === null
      ? "—"
      : `${(alert.epss.percentage <= 1 ? alert.epss.percentage * 100 : alert.epss.percentage).toFixed(2)}%`;
  const displayDate = (value: string) => relativeTime(value) || value || "—";

  return (
    <div className="flex flex-col gap-5" aria-busy={loading}>
      {loading ? <RefreshBar visible /> : null}
      {error !== null ? (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-xs text-red-600 dark:text-red-400"
        >
          <span>Could not refresh this alert: {error}</span>
          <Button size="sm" variant="outline" className="h-7 shrink-0" onClick={load}>
            Retry
          </Button>
        </div>
      ) : null}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Button size="sm" variant="ghost" className="h-7 px-2" onClick={onBack}>
          ← Dependabot
        </Button>
        <span className="min-w-0 truncate">{repo} · alert #{number}</span>
        <span className="flex-1" />
        <SafeUrlLink href={alert.htmlUrl} className="shrink-0 underline hover:text-foreground">
          Open on GitHub ↗
        </SafeUrlLink>
      </div>
      <section className="rounded-xl border border-border bg-card p-4">
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="capitalize">Dependabot alert</Badge>
            <Badge variant="secondary" className="gap-1.5 capitalize">
              <span className={"size-2 rounded-full " + (alert.state.toLowerCase() === "open" ? "bg-green-500" : "bg-muted-foreground/50")} aria-hidden="true" />
              {alert.state}
            </Badge>
            <span className={"inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium uppercase " + severityClass(advisorySeverity)}>
              <span className={"size-2 rounded-full " + severityDotClass(advisorySeverity)} aria-hidden="true" />
              {advisorySeverity}
            </span>
          </div>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <p className="text-xs uppercase tracking-wider text-muted-foreground">
                {alert.packageName} · {alert.ecosystem}
              </p>
              <h2 className="break-words text-xl font-semibold tracking-tight text-foreground">
                {alert.packageName}
              </h2>
              <p className="mt-1 max-w-3xl text-sm leading-snug text-muted-foreground">
                {alert.summary || "No advisory summary provided."}
              </p>
            </div>
            <div className="shrink-0 rounded-lg bg-muted/50 px-3 py-2 text-right">
              <p className="font-mono text-sm font-medium text-foreground">#{alert.number}</p>
              <p className="text-xs text-muted-foreground">in {repo}</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {alert.ghsaId.length > 0 ? <Badge variant="secondary" className="font-mono font-normal">{alert.ghsaId}</Badge> : null}
            {alert.cveId !== null ? <Badge variant="secondary" className="font-mono font-normal">{alert.cveId}</Badge> : null}
            {alert.classification.length > 0 ? <Badge variant="secondary" className="capitalize">{alert.classification}</Badge> : null}
          </div>
        </div>
      </section>
      <div className="flex flex-col gap-5 @[48rem]:flex-row">
        <main className="flex min-w-0 flex-col gap-5 @[48rem]:flex-1">
          <section className="overflow-hidden rounded-xl border border-border bg-card">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/50 px-4 py-3">
              <div>
                <h3 className="text-sm font-medium text-foreground">Affected versions</h3>
                <p className="mt-0.5 text-xs text-muted-foreground">Packages and ranges reported by the advisory</p>
              </div>
              {patchedVersion !== null ? (
                <Badge variant="outline" className="shrink-0 gap-1.5">
                  <span className="size-2 rounded-full bg-green-500" aria-hidden="true" />
                  Fix available: {patchedVersion}
                </Badge>
              ) : <Badge variant="secondary">No fix listed</Badge>}
            </div>
            {alert.vulnerabilities.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">No affected-version details provided.</p>
            ) : (
              <div className="divide-y divide-border">
                <div className="hidden items-center gap-3 bg-muted/50 px-4 py-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground @[48rem]:flex">
                  <span className="@[48rem]:flex-1">Package</span>
                  <span className="@[48rem]:flex-1">Affected range</span>
                  <span className="@[48rem]:w-24 text-right">First patched</span>
                </div>
                {alert.vulnerabilities.map((entry, index) => (
                  <div key={entry.packageName + entry.vulnerableVersionRange + index} className="flex flex-col gap-3 px-4 py-3 @[48rem]:flex-row @[48rem]:items-center @[48rem]:gap-3">
                    <div className="min-w-0 @[48rem]:flex-1">
                      <p className="font-medium text-foreground">{entry.packageName}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">{entry.ecosystem}</p>
                    </div>
                    <div className="min-w-0 @[48rem]:flex-1">
                      <p className="hidden mb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground @[48rem]:block">Affected range</p>
                      <p className="font-mono text-xs text-foreground">{entry.vulnerableVersionRange || "—"}</p>
                    </div>
                    <div className="@[48rem]:w-24 @[48rem]:text-right">
                      <p className="hidden mb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground @[48rem]:block">First patched</p>
                      <p className={entry.firstPatchedVersion !== null ? "font-medium text-foreground" : "text-sm text-muted-foreground"}>
                        {entry.firstPatchedVersion ?? "No fix available"}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
          <section className="overflow-hidden rounded-xl border border-border bg-card">
            <div className="border-b border-border bg-muted/50 px-4 py-3">
              <h3 className="text-sm font-medium text-foreground">Advisory description</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">Why this dependency is flagged</p>
            </div>
            <div className="max-w-3xl p-4">
              {alert.description.length > 0 ? <Markdown content={alert.description} className="text-sm leading-snug" /> : <p className="text-sm text-muted-foreground">No advisory description provided.</p>}
            </div>
          </section>
          {alert.references.length > 0 ? (
            <section className="overflow-hidden rounded-xl border border-border bg-card">
              <div className="border-b border-border bg-muted/50 px-4 py-3">
                <h3 className="text-sm font-medium text-foreground">References</h3>
                <p className="mt-0.5 text-xs text-muted-foreground">{alert.references.length} advisory links</p>
              </div>
              <div className="divide-y divide-border">
                {alert.references.map((reference) => (
                  <SafeUrlLink key={reference} href={reference} className="block break-words px-4 py-3 text-sm text-foreground underline underline-offset-2 hover:text-primary">{reference}</SafeUrlLink>
                ))}
              </div>
            </section>
          ) : null}
        </main>
        <aside className="flex w-full max-w-full shrink-0 flex-col gap-5 @[48rem]:w-56">
          <section className="rounded-xl border border-border bg-muted/50 p-4">
            <h3 className="flex items-center gap-2 text-sm font-medium text-foreground"><span className="size-2 rounded-full bg-green-500" aria-hidden="true" />Remediation</h3>
            {patchedVersion !== null ? (
              <div className="mt-3">
                <p className="text-xs text-muted-foreground">Upgrade to</p>
                <p className="mt-1 font-mono text-lg font-semibold text-foreground">{patchedVersion}</p>
                <p className="mt-1 text-xs leading-snug text-muted-foreground">This is the first patched version reported by GitHub.</p>
              </div>
            ) : <p className="mt-3 text-sm leading-snug text-muted-foreground">GitHub has not listed a patched version yet.</p>}
          </section>
          <section className="rounded-xl border border-border bg-card p-4 text-sm">
            <h3 className="text-sm font-medium text-foreground">Dependency</h3>
            <dl className="mt-3 space-y-2 text-xs">
              {[['Package', alert.packageName], ['Ecosystem', alert.ecosystem], ['Manifest', alert.dependencyManifestPath || '—'], ['Scope', alert.dependencyScope || '—'], ['Relationship', alert.dependencyRelationship || '—']].map(([label, value]) => (
                <div key={label} className="flex items-start justify-between gap-3">
                  <dt className="shrink-0 text-muted-foreground">{label}</dt>
                  <dd className="min-w-0 break-words text-right font-medium text-foreground">{value}</dd>
                </div>
              ))}
            </dl>
          </section>
          <section className="rounded-xl border border-border bg-card p-4">
            <h3 className="text-sm font-medium text-foreground">Scoring</h3>
            <div className="mt-3 flex gap-2">
              {[['CVSS', alert.cvss.score], ['v3', alert.cvssV3.score], ['v4', alert.cvssV4.score]].map(([label, score]) => (
                <div key={label} className="min-w-0 flex-1 rounded-lg bg-muted/50 p-3">
                  <p className="text-[11px] text-muted-foreground">{label}</p>
                  <p className="mt-1 text-lg font-semibold text-foreground">{score ?? '—'}</p>
                </div>
              ))}
            </div>
            <div className="mt-3 flex flex-col gap-2">
              {alert.cvss.vectorString !== null ? <p className="break-words font-mono text-[11px] leading-snug text-muted-foreground">{alert.cvss.vectorString}</p> : null}
              {alert.cvssV3.vectorString !== null ? <p className="break-words font-mono text-[11px] leading-snug text-muted-foreground">{alert.cvssV3.vectorString}</p> : null}
              {alert.cvssV4.vectorString !== null ? <p className="break-words font-mono text-[11px] leading-snug text-muted-foreground">{alert.cvssV4.vectorString}</p> : null}
              <p className="text-sm text-foreground">EPSS {epss}</p>
            </div>
          </section>
          <section className="rounded-xl border border-border bg-card p-4">
            <h3 className="text-sm font-medium text-foreground">Timeline</h3>
            <div className="mt-3 flex flex-col gap-2.5 border-l border-border pl-3 text-sm">
              <p><span className="text-muted-foreground">Published </span>{displayDate(alert.publishedAt)}</p>
              <p><span className="text-muted-foreground">Advisory updated </span>{displayDate(alert.advisoryUpdatedAt)}</p>
              <p><span className="text-muted-foreground">Alert created </span>{displayDate(alert.createdAt)}</p>
              <p><span className="text-muted-foreground">Alert updated </span>{displayDate(alert.updatedAt)}</p>
              {alert.withdrawnAt !== null ? <p><span className="text-muted-foreground">Withdrawn </span>{displayDate(alert.withdrawnAt)}</p> : null}
              {alert.dismissedAt !== null ? <p><span className="text-muted-foreground">Dismissed </span>{displayDate(alert.dismissedAt)}</p> : null}
              {alert.autoDismissedAt !== null ? <p><span className="text-muted-foreground">Auto-dismissed </span>{displayDate(alert.autoDismissedAt)}</p> : null}
              {alert.fixedAt !== null ? <p><span className="text-muted-foreground">Fixed </span>{displayDate(alert.fixedAt)}</p> : null}
            </div>
          </section>
          <section className="rounded-xl border border-border bg-card p-4">
            <h3 className="text-sm font-medium text-foreground">Advisory metadata</h3>
            {alert.assignees.length > 0 ? <div className="mt-3"><p className="text-xs text-muted-foreground">Assignees</p><div className="mt-1 flex flex-wrap gap-1.5">{alert.assignees.map((login) => <Badge key={login} variant="secondary" className="font-normal">{login}</Badge>)}</div></div> : null}
            {alert.identifiers.length > 0 ? <div className="mt-3"><p className="text-xs text-muted-foreground">Identifiers</p><div className="mt-1 flex flex-wrap gap-1.5">{alert.identifiers.map((identifier) => <Badge key={identifier.type + identifier.value} variant="secondary" className="font-mono font-normal">{identifier.type}: {identifier.value}</Badge>)}</div></div> : null}
            {alert.cwes.length > 0 ? <div className="mt-3"><p className="text-xs text-muted-foreground">Weaknesses</p><div className="mt-1 flex flex-col gap-1">{alert.cwes.map((cwe) => <p key={cwe.id} className="text-sm text-foreground">{cwe.id}{cwe.name.length > 0 ? ` · ${cwe.name}` : ""}</p>)}</div></div> : null}
            {alert.dismissedBy !== null || alert.dismissedComment !== null ? <div className="mt-3 border-t border-border pt-3">{alert.dismissedBy !== null ? <p className="text-sm text-foreground">Dismissed by {alert.dismissedBy}</p> : null}{alert.dismissedComment !== null ? <p className="mt-1 text-sm leading-snug text-muted-foreground">{alert.dismissedComment}</p> : null}</div> : null}
            {alert.assignees.length === 0 && alert.identifiers.length === 0 && alert.cwes.length === 0 && alert.dismissedBy === null && alert.dismissedComment === null ? <p className="mt-3 text-sm text-muted-foreground">No additional metadata provided.</p> : null}
          </section>
        </aside>
      </div>
    </div>
  );
}

function ListView({
  kind,
  query,
  setQuery,
  repos,
  onOpenItem,
}: {
  kind: "issue" | "pr";
  query: string;
  setQuery: (query: string) => void;
  repos: RepoInfo[];
  onOpenItem: (repo: string, number: number) => void;
}) {
  const { items, error, loading, refetch } = useItems(kind);
  const viewer = useViewer();
  const parsed = useMemo(() => parseQuery(query), [query]);
  const filtered = useMemo(
    () =>
      items === null
        ? null
        : items.filter((item) => matchesQuery(item, parsed, viewer)),
    [items, parsed, viewer],
  );
  const [page, setPage] = useState(0);
  const pageSize = 25;
  const paginated = kind === "pr";
  useEffect(() => setPage(0), [kind, query, filtered?.length]);
  const pageCount = !paginated || filtered === null ? 1 : Math.max(1, Math.ceil(filtered.length / pageSize));
  const visiblePage = !paginated || filtered === null || filtered.length === 0 ? 0 : Math.min(page, pageCount - 1);
  const pageItems = filtered === null || !paginated ? filtered : filtered.slice(visiblePage * pageSize, (visiblePage + 1) * pageSize);
  return (
    <div className="flex flex-col gap-3">
      <div className="sticky top-0 z-10 flex flex-col gap-2 bg-background pb-1">
        <FilterBar
          value={query}
          onChange={setQuery}
          items={items}
          repos={repos}
          kind={kind}
        />
        <SavedViewsBar tab={kind === "pr" ? "pulls" : "issues"} query={query} onChange={setQuery} />
      </div>
      {filtered === null ? (
        <div className="flex items-center justify-between px-1">
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-3 w-40" />
        </div>
      ) : (
        <div className="flex items-center justify-between px-1 text-xs text-muted-foreground" aria-live="polite">
          <span className="font-medium text-foreground">
            {filtered.length} {kind === "pr" ? "pull requests" : "issues"}
          </span>
          {loading ? (
            <span className="inline-flex items-center gap-1.5">
              <Spinner className="size-3" />
              Updating
            </span>
          ) : (
            <span>{query.trim().length > 0 ? "Filtered results" : "Across tracked repositories"}</span>
          )}
        </div>
      )}
      <ItemsTable
        kind={kind}
        items={pageItems}
        error={error}
        loading={loading}
        hasFilter={query.trim().length > 0}
        onRetry={refetch}
        onClearFilter={() => setQuery("")}
        onOpenItem={onOpenItem}
        page={visiblePage}
        pageCount={pageCount}
        total={filtered?.length ?? 0}
        pageSize={pageSize}
        showPagination={paginated}
        onPageChange={setPage}
      />
    </div>
  );
}

function GithubPanelBody({
  route,
  navigate,
  status,
  loading,
  query,
  setQuery,
  onRetryStatus,
}: {
  route: Route;
  navigate: (route: Route) => void;
  status: Status | null;
  loading: boolean;
  query: string;
  setQuery: (query: string) => void;
  onRetryStatus: () => void;
}) {
  const [reposOpen, setReposOpen] = useState(false);
  const selectRepo = useCallback((repo: string) => {
    setQuery(`repo:${repo}`);
    setReposOpen(false);
  }, [setQuery]);
  const openItem = useCallback(
    (itemKind: "issue" | "pr", repo: string, number: number) => {
      navigate(
        itemKind === "pr"
          ? { view: "pull", repo, number }
          : { view: "issue", repo, number },
      );
    },
    [navigate],
  );
  useEffect(() => {
    if (status !== null && status.repos.length === 0) setReposOpen(true);
  }, [status]);
  if (status !== null && status.ghState === "unavailable") {
    return (
      <EmptyState
        title="GitHub is unreachable"
        message={`GitHub CLI could not reach GitHub. Check your network or keychain; the plugin retries by itself. (${status.ghError ?? ""})`}
        onRetry={onRetryStatus}
        retryLabel="Retry GitHub status"
      />
    );
  }
  if (status !== null && !status.ghOk) {
    return (
      <EmptyState
        title="GitHub CLI isn't ready"
        message={`GitHub CLI is not available or not authenticated. Install it from cli.github.com, run \`gh auth login\`, then reload the plugin. (${status.ghError ?? ""})`}
        onRetry={onRetryStatus}
        retryLabel="Retry GitHub status"
      />
    );
  }
  if (route.view === "issue") {
    return (
      <IssueDetailView
        repo={route.repo}
        number={route.number}
        onBack={() => navigate({ view: "issues" })}
      />
    );
  }
  if (route.view === "pull") {
    return (
      <PullDetailView
        repo={route.repo}
        number={route.number}
        onBack={() => navigate({ view: "pulls" })}
      />
    );
  }

  if (route.view === "dependabot-alert") {
    return (
      <DependabotDetailView
        repo={route.repo}
        number={route.number}
        onBack={() => navigate({ view: "dependabot" })}
      />
    );
  }
  if (route.view === "new") {
    return (
      <NewIssueForm
        repos={status?.repos ?? []}
        onCreated={(repo, number) =>
          navigate(
            number !== null
              ? { view: "issue", repo, number }
              : { view: "issues" },
          )
        }
        onCancel={() => navigate({ view: "issues" })}
      />
    );
  }

  const listTab =
    route.view === "pulls"
      ? "pulls"
      : route.view === "dependabot"
        ? "dependabot"
        : "issues";
  const kind = listTab === "pulls" ? "pr" : "issue";
  const repoCount = status?.repos.length ?? 0;
  const refreshing = loading || status?.syncing === true;

  return (
    <Tabs
      value={listTab}
      onValueChange={(value) => {
        navigate(
          value === "pulls"
            ? { view: "pulls" }
            : value === "dependabot"
              ? { view: "dependabot" }
              : { view: "issues" },
        );
      }}
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <TabsList>
            <TabsTrigger value="issues">Issues</TabsTrigger>
            <TabsTrigger value="pulls">Pull requests</TabsTrigger>
            <TabsTrigger value="dependabot">Dependabot</TabsTrigger>
          </TabsList>
          <div className="flex-1" />
          <Button
            size="sm"
            variant={reposOpen ? "secondary" : "outline"}
            className="h-8 gap-1.5"
            aria-expanded={reposOpen}
            aria-controls="github-repos-drawer"
            aria-busy={refreshing}
            aria-label={
              status === null
                ? refreshing
                  ? "Loading repositories"
                  : "Repositories"
                : `${repoCount} repo${repoCount === 1 ? "" : "s"}, ${repoHealthSummary(status)}${refreshing ? ", refreshing" : ""}`
            }
            title={
              status === null
                ? refreshing
                  ? "Loading repositories"
                  : "Repositories"
                : refreshing
                  ? `Refreshing · ${repoHealthSummary(status)}`
                  : repoHealthSummary(status)
            }
            onClick={() => setReposOpen((open) => !open)}
          >
            {refreshing ? <Spinner className="size-3" /> : null}
            <RepoHealthDots status={status} />
            {status === null ? "Repos" : `${repoCount} repo${repoCount === 1 ? "" : "s"}`}
          </Button>
          {listTab === "issues" ? (
            <Button size="sm" className="h-8" onClick={() => navigate({ view: "new" })}>
              New issue
            </Button>
          ) : null}
        </div>
        {reposOpen ? (
          <div id="github-repos-drawer">
            <ReposDrawer status={status} onSelectRepo={selectRepo} />
          </div>
        ) : null}
        <TabsPanel value={listTab}>
          {listTab === "dependabot" ? (
            <DependabotListView
              query={query}
              setQuery={setQuery}
              repos={status?.repos ?? []}
              onOpenAlert={(repo, number) => navigate({ view: "dependabot-alert", repo, number })}
            />
          ) : (
            <ListView
              kind={kind}
              query={query}
              setQuery={setQuery}
              repos={status?.repos ?? []}
              onOpenItem={(repo, number) =>
                openItem(kind === "pr" ? "pr" : "issue", repo, number)
              }
            />
          )}
        </TabsPanel>
      </div>
    </Tabs>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "github",
    title: "GitHub+",
    icon: "Github",
    path: "github",
    component: GithubPanel,
    headerContent: PanelHeader,
  });
  app.slots.threadPanelAction({
    id: "pull",
    title: "GitHub+ PR",
    icon: "Github",
    component: PullPanelTab,
  });
});
