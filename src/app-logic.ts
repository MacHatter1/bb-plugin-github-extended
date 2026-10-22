import type { PullRequestSummary } from "./pull-status.js";

export interface Item {
  repo: string;
  number: number;
  kind: "issue" | "pr";
  title: string;
  state: string;
  author: string;
  labels: string[];
  labelColors?: Record<string, string>;
  assignees: string[];
  url: string;
  body: string;
  updatedAt: string;
  pullRequest?: PullRequestSummary;
}

export function isSafeExternalUrl(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    /[\u0000-\u0020\u007f]/.test(value) ||
    !/^https?:\/\/[^/]/i.test(value)
  ) {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.hostname.length > 0 &&
      url.username.length === 0 &&
      url.password.length === 0
    );
  } catch {
    return false;
  }
}

export const AUTOMATION_PAGES = ["setup", "rules", "create", "events", "audit", "polling"] as const;
export type AutomationPage = (typeof AUTOMATION_PAGES)[number];

export function isAutomationPage(value: string | undefined): value is AutomationPage {
  return value !== undefined && (AUTOMATION_PAGES as readonly string[]).includes(value);
}

export type Route =
  | { view: "inbox" }
  | { view: "activity" }
  | { view: "agent"; kind: "issue" | "pr" | "security"; repo: string; number: number }
  | { view: "issues" }
  | { view: "pulls" }
  | { view: "dependabot" }
  | { view: "dependabot-alert"; repo: string; number: number }
  | { view: "automation"; page: AutomationPage }
  | { view: "new" }
  | { view: "issue"; repo: string; number: number }
  | { view: "pull"; repo: string; number: number };

function parsePositiveIntegerSegment(value: string): number | null {
  if (!/^[0-9]+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

export function parseSubPath(subPath: string): Route {
  const parts = subPath.split("/").filter((part) => part.length > 0);
  if (parts[0] === "agent" && parts.length === 5 && (parts[1] === "issue" || parts[1] === "pr" || parts[1] === "security")) {
    const number = parsePositiveIntegerSegment(parts[4]);
    if (number !== null) return { view: "agent", kind: parts[1], repo: `${parts[2]}/${parts[3]}`, number };
  }
  if (parts[0] === "pulls" && parts.length === 4) {
    const number = parsePositiveIntegerSegment(parts[3]);
    if (number !== null) {
      return { view: "pull", repo: `${parts[1]}/${parts[2]}`, number };
    }
  }
  if (parts[0] === "pulls") return { view: "pulls" };
  if (parts[0] === "dependabot" && parts.length === 4) {
    const number = parsePositiveIntegerSegment(parts[3]);
    if (number !== null) {
      return { view: "dependabot-alert", repo: parts[1] + "/" + parts[2], number };
    }
  }
  if (parts[0] === "dependabot") return { view: "dependabot" };
  if (parts[0] === "automation") {
    return { view: "automation", page: isAutomationPage(parts[1]) ? parts[1] : "rules" };
  }
  if (parts[0] === "activity") return { view: "activity" };
  if (parts[0] === "new") return { view: "new" };
  if (parts[0] === "issues" && parts.length === 4) {
    const number = parsePositiveIntegerSegment(parts[3]);
    if (number !== null) {
      return { view: "issue", repo: `${parts[1]}/${parts[2]}`, number };
    }
  }
  return parts[0] === "issues" ? { view: "issues" } : { view: "inbox" };
}

export function routeToSubPath(route: Route): string {
  switch (route.view) {
    case "inbox":
      return "";
    case "activity":
      return "activity";
    case "agent":
      return `agent/${route.kind}/${route.repo}/${route.number}`;
    case "issues":
      return "issues";
    case "pulls":
      return "pulls";
    case "dependabot":
      return "dependabot";
    case "dependabot-alert":
      return "dependabot/" + route.repo + "/" + route.number;
    case "automation":
      return route.page === "rules" ? "automation" : `automation/${route.page}`;
    case "new":
      return "new";
    case "issue":
      return `issues/${route.repo}/${route.number}`;
    case "pull":
      return `pulls/${route.repo}/${route.number}`;
  }
}

interface ParsedQuery {
  states: string[];
  assignees: string[];
  authors: string[];
  labels: string[];
  repos: string[];
  noAssignee: boolean;
  noLabel: boolean;
  text: string[];
}

const REPOSITORY_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$/;

/** Normalize a GitHub repository name or URL to the owner/repository form used by RPC. */
export function normalizeRepositoryReference(value: string): string | null {
  const input = value.trim();
  if (input.length === 0) return null;

  let candidate = input;
  const sshMatch = input.match(
    /^(?:git@github\.com:|ssh:\/\/git@github\.com\/)(.+)$/i,
  );
  if (sshMatch !== null) {
    candidate = sshMatch[1]!.replace(/\/+$/, "").replace(/\.git$/i, "");
  } else if (/^(?:https?:\/\/|github\.com\/)/i.test(input)) {
    let url: URL;
    try {
      url = new URL(/^github\.com\//i.test(input) ? `https://${input}` : input);
    } catch {
      return null;
    }
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.hostname.toLowerCase() !== "github.com" ||
      url.username.length > 0 ||
      url.password.length > 0
    ) {
      return null;
    }
    candidate = url.pathname.replace(/\/+$/, "").replace(/\.git$/i, "").slice(1);
  }

  if (!REPOSITORY_NAME_PATTERN.test(candidate)) return null;
  return candidate.toLowerCase();
}

function tokenizeQuery(query: string): string[] {
  return query.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
}

export function queryHasToken(query: string, token: string): boolean {
  const needle = token.toLowerCase();
  return tokenizeQuery(query).some((entry) => entry.toLowerCase() === needle);
}

export function withoutPrefixedTokens(query: string, prefixes: readonly string[]): string {
  const lowered = prefixes.map((prefix) => prefix.toLowerCase());
  return tokenizeQuery(query)
    .filter((entry) => !lowered.some((prefix) => entry.toLowerCase().startsWith(prefix)))
    .join(" ")
    .trim();
}

export function toggleQueryToken(
  query: string,
  token: string,
  exclusivePrefixes: readonly string[] = [],
): string {
  if (queryHasToken(query, token)) {
    return tokenizeQuery(query)
      .filter((entry) => entry.toLowerCase() !== token.toLowerCase())
      .join(" ")
      .trim();
  }
  const base =
    exclusivePrefixes.length > 0 ? withoutPrefixedTokens(query, exclusivePrefixes) : query.trim();
  return `${base} ${token}`.trim();
}

function unquote(value: string): string {
  return value.replace(/"/g, "");
}

const STATE_VALUES: Record<string, string> = {
  open: "OPEN",
  draft: "DRAFT",
  closed: "CLOSED",
  merged: "MERGED",
};

/** `is:open` includes draft pull requests, as it does on GitHub; `is:draft` narrows to them. */
function stateMatches(wanted: string, actual: string): boolean {
  return wanted === actual || (wanted === "OPEN" && actual === "DRAFT");
}

export type RepoHealthStatus = "never" | "syncing" | "healthy" | "partial" | "failed";

export interface RepoInfo {
  repo: string;
  projectId: string | null;
}

export interface RepoHealth {
  status: RepoHealthStatus;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  itemCount: number;
  alertCount: number;
  error: string | null;
}

export interface RepoStatus extends RepoInfo {
  health: RepoHealth;
}

export interface GithubStatus {
  ghOk: boolean;
  ghState: "ready" | "needs_configuration" | "unavailable";
  ghError: string | null;
  repos: RepoStatus[];
  lastSyncedAt: string | null;
  syncing: boolean;
}

const REPO_HEALTH_STATUSES: readonly RepoHealthStatus[] = [
  "never",
  "syncing",
  "healthy",
  "partial",
  "failed",
];

const REPO_HEALTH_RANK: Record<RepoHealthStatus, number> = {
  healthy: 0,
  never: 1,
  partial: 2,
  syncing: 3,
  failed: 4,
};

export function repoHealthDotClass(status: RepoHealthStatus): string {
  if (status === "healthy") return "bg-green-500";
  if (status === "syncing") return "animate-pulse bg-yellow-500";
  if (status === "failed") return "bg-red-500";
  return "bg-muted-foreground/50";
}

export function worstRepoHealth(
  statuses: readonly RepoHealthStatus[],
): RepoHealthStatus | null {
  if (statuses.length === 0) return null;
  let worst: RepoHealthStatus = "healthy";
  for (const status of statuses) {
    if (REPO_HEALTH_RANK[status] > REPO_HEALTH_RANK[worst]) worst = status;
  }
  return worst;
}

const HEALTH_SUMMARY_LABELS: Array<[RepoHealthStatus, string]> = [
  ["healthy", "healthy"],
  ["partial", "partial"],
  ["syncing", "syncing"],
  ["failed", "failed"],
  ["never", "not synced"],
];

export function summarizeRepoHealth(statuses: readonly RepoHealthStatus[]): string {
  if (statuses.length === 0) return "not synced";
  const counts: Record<RepoHealthStatus, number> = {
    never: 0,
    syncing: 0,
    healthy: 0,
    partial: 0,
    failed: 0,
  };
  for (const status of statuses) counts[status] += 1;
  return HEALTH_SUMMARY_LABELS.filter(([status]) => counts[status] > 0)
    .map(([status, label]) => `${counts[status]} ${label}`)
    .join(", ");
}

export type RepoHealthTone = "healthy" | "syncing" | "muted" | "failed";

export function repoHealthColorCounts(
  statuses: readonly RepoHealthStatus[],
): Array<{ tone: RepoHealthTone; count: number }> {
  let healthy = 0;
  let syncing = 0;
  let failed = 0;
  let muted = 0;
  for (const status of statuses) {
    if (status === "healthy") healthy += 1;
    else if (status === "syncing") syncing += 1;
    else if (status === "failed") failed += 1;
    else muted += 1;
  }
  return (
    [
      { tone: "healthy", count: healthy },
      { tone: "syncing", count: syncing },
      { tone: "muted", count: muted },
      { tone: "failed", count: failed },
    ] as const
  ).filter((row) => row.count > 0);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonNegativeInteger(value: unknown): number {
  const candidate =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : 0;
  return Number.isFinite(candidate) && candidate >= 0 ? Math.floor(candidate) : 0;
}

function normalizeRepoHealth(value: unknown): RepoHealth {
  const raw = asRecord(value);
  const candidateStatus =
    typeof raw?.status === "string" ? raw.status.toLowerCase() : "";
  const status = REPO_HEALTH_STATUSES.includes(
    candidateStatus as RepoHealthStatus,
  )
    ? (candidateStatus as RepoHealthStatus)
    : "never";
  return {
    status,
    lastAttemptAt:
      typeof raw?.lastAttemptAt === "string" ? raw.lastAttemptAt : null,
    lastSuccessAt:
      typeof raw?.lastSuccessAt === "string" ? raw.lastSuccessAt : null,
    itemCount: nonNegativeInteger(raw?.itemCount),
    alertCount: nonNegativeInteger(raw?.alertCount),
    error: typeof raw?.error === "string" ? raw.error : null,
  };
}

export function normalizeStatus(value: unknown): GithubStatus | null {
  const raw = asRecord(value);
  if (raw === null) return null;

  const candidateState =
    typeof raw.ghState === "string" ? raw.ghState : "";
  const ghState =
    candidateState === "ready" ||
    candidateState === "needs_configuration" ||
    candidateState === "unavailable"
      ? candidateState
      : raw.ghOk === true
        ? "ready"
        : "needs_configuration";

  const repos = Array.isArray(raw.repos)
    ? raw.repos.flatMap((entry): RepoStatus[] => {
        const repo = asRecord(entry);
        if (typeof repo?.repo !== "string" || repo.repo.length === 0) {
          return [];
        }
        return [
          {
            repo: repo.repo,
            projectId: typeof repo.projectId === "string" ? repo.projectId : null,
            health: normalizeRepoHealth(repo.health),
          },
        ];
      })
    : [];

  return {
    ghOk: ghState === "ready",
    ghState,
    ghError: typeof raw.ghError === "string" ? raw.ghError : null,
    repos,
    lastSyncedAt:
      typeof raw.lastSyncedAt === "string" ? raw.lastSyncedAt : null,
    syncing: raw.syncing === true,
  };
}

export function parseQuery(query: string): ParsedQuery {
  const parsed: ParsedQuery = {
    states: [],
    assignees: [],
    authors: [],
    labels: [],
    repos: [],
    noAssignee: false,
    noLabel: false,
    text: [],
  };
  for (const token of tokenizeQuery(query)) {
    const idx = token.indexOf(":");
    const key = idx > 0 ? token.slice(0, idx).toLowerCase() : "";
    const value = idx > 0 ? unquote(token.slice(idx + 1)) : "";
    if (idx > 0 && value.length === 0) continue;
    if (key === "is" || key === "state") {
      parsed.states.push(
        STATE_VALUES[value.toLowerCase()] ?? value.toUpperCase(),
      );
    } else if (key === "assignee") {
      parsed.assignees.push(value.toLowerCase());
    } else if (key === "author") {
      parsed.authors.push(value.toLowerCase());
    } else if (key === "label") {
      parsed.labels.push(value.toLowerCase());
    } else if (key === "repo") {
      parsed.repos.push(value.toLowerCase());
    } else if (key === "no") {
      if (value.toLowerCase() === "assignee") parsed.noAssignee = true;
      if (value.toLowerCase() === "label") parsed.noLabel = true;
    } else {
      parsed.text.push(unquote(token).toLowerCase());
    }
  }
  return parsed;
}

export function matchesQuery(
  item: Item,
  query: ParsedQuery,
  viewer: string | null,
): boolean {
  if (
    query.states.length > 0 &&
    !query.states.some((state) => stateMatches(state, item.state))
  ) {
    return false;
  }
  if (query.assignees.length > 0) {
    const wanted = query.assignees.map((login) =>
      login === "@me" ? (viewer?.toLowerCase() ?? "\u0000") : login,
    );
    if (!item.assignees.some((login) => wanted.includes(login.toLowerCase()))) {
      return false;
    }
  }
  if (query.authors.length > 0) {
    const author = item.author.toLowerCase();
    const wanted = query.authors.map((login) =>
      login === "@me" ? (viewer?.toLowerCase() ?? "\u0000") : login,
    );
    if (!wanted.includes(author)) return false;
  }
  if (query.labels.length > 0) {
    const labels = item.labels.map((label) => label.toLowerCase());
    if (!query.labels.some((label) => labels.includes(label))) return false;
  }
  if (
    query.repos.length > 0 &&
    !query.repos.includes(item.repo.toLowerCase())
  ) {
    return false;
  }
  if (query.noAssignee && item.assignees.length > 0) return false;
  if (query.noLabel && item.labels.length > 0) return false;
  if (query.text.length > 0) {
    const haystack = `${item.title} #${item.number} ${item.repo}`.toLowerCase();
    if (!query.text.every((term) => haystack.includes(term))) return false;
  }
  return true;
}

export type SuggestionIcon =
  | { kind: "state"; itemKind: "issue" | "pr"; state: string }
  | { kind: "avatar"; login: string };

export interface Suggestion {
  insert: string;
  label: string;
  hint?: string;
  icon?: SuggestionIcon;
}

const QUALIFIER_KEYS: Array<{ key: string; hint: string }> = [
  { key: "is:", hint: "state — open, closed, merged, draft" },
  { key: "assignee:", hint: "assigned user, or @me" },
  { key: "author:", hint: "opened by" },
  { key: "label:", hint: "has label" },
  { key: "repo:", hint: "in repository" },
  { key: "no:", hint: "missing — assignee, label" },
];

const DEPENDABOT_QUALIFIER_KEYS: Array<{ key: string; hint: string }> = [
  { key: "repo:", hint: "in repository" },
  { key: "is:", hint: "state — open, dismissed, fixed" },
  { key: "severity:", hint: "critical, high, moderate, low" },
  { key: "fix:", hint: "yes or no" },
];

function quoteValue(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

export function buildSuggestions(
  token: string,
  vocab: { users: string[]; labels: string[]; repos: string[] },
  kind: "issue" | "pr" | "dependabot",
  viewer: string | null,
): Suggestion[] {
  const idx = token.indexOf(":");
  if (idx <= 0) {
    const prefix = token.toLowerCase();
    const keys = kind === "dependabot" ? DEPENDABOT_QUALIFIER_KEYS : QUALIFIER_KEYS;
    return keys.filter((entry) => entry.key.startsWith(prefix)).map(
      (entry) => ({
        insert: entry.key,
        label: entry.key,
        hint: entry.hint,
      }),
    );
  }
  const key = token.slice(0, idx).toLowerCase();
  const partial = unquote(token.slice(idx + 1)).toLowerCase();
  const matches = (value: string) => value.toLowerCase().includes(partial);
  if (kind === "dependabot") {
    if (key === "repo") {
      return vocab.repos.filter(matches).map((repo) => ({
        insert: `${key}:${repo} `,
        label: repo,
      }));
    }
    if (key === "is" || key === "state") {
      return ["open", "dismissed", "fixed"].filter(matches).map((state) => ({
        insert: `${key}:${state} `,
        label: state,
      }));
    }
    if (key === "severity") {
      return ["critical", "high", "moderate", "low"].filter(matches).map((severity) => ({
        insert: `${key}:${severity} `,
        label: severity,
      }));
    }
    if (key === "fix" || key === "has") {
      return ["yes", "no"].filter(matches).map((value) => ({
        insert: `${key}:${value} `,
        label: value,
      }));
    }
    return [];
  }
  if (key === "is" || key === "state") {
    const states =
      kind === "pr" ? ["open", "draft", "closed", "merged"] : ["open", "closed"];
    return states.filter(matches).map((state) => ({
      insert: `${key}:${state} `,
      label: state,
      icon: {
        kind: "state",
        itemKind: kind,
        state: STATE_VALUES[state] ?? "OPEN",
      },
    }));
  }
  if (key === "assignee" || key === "author") {
    const users = ["@me", ...vocab.users];
    return users.filter(matches).map((login) => {
      const avatarLogin = login === "@me" ? viewer : login;
      const icon: SuggestionIcon | undefined =
        avatarLogin === null
          ? undefined
          : { kind: "avatar", login: avatarLogin };
      return {
        insert: `${key}:${login} `,
        label: login === "@me" && viewer !== null ? `@me (${viewer})` : login,
        ...(icon === undefined ? {} : { icon }),
      };
    });
  }
  if (key === "label") {
    return vocab.labels.filter(matches).map((label) => ({
      insert: `${key}:${quoteValue(label)} `,
      label,
    }));
  }
  if (key === "repo") {
    return vocab.repos.filter(matches).map((repo) => ({
      insert: `${key}:${repo} `,
      label: repo,
    }));
  }
  if (key === "no") {
    return ["assignee", "label"].filter(matches).map((field) => ({
      insert: `${key}:${field} `,
      label: `no:${field}`,
    }));
  }
  return [];
}
