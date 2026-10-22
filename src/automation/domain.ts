// Automation domain model shared by the server engine, the panel UI, the
// agent tool, and the CLI. Pure data — no Node or browser imports.

export const EVENT_KINDS = [
  "issue.opened",
  "issue.edited",
  "issue.closed",
  "issue.reopened",
  "issue.labeled",
  "issue.unlabeled",
  "issue.assigned",
  "issue.unassigned",
  "pr.opened",
  "pr.synchronised",
  "pr.review_requested",
  "pr.approved",
  "pr.changes_requested",
  "ci.success",
  "ci.failure",
  "pr.merged",
  "pr.closed",
  "push.base",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const ACTION_KINDS = [
  "bb.review",
  "bb.agent",
  "github.comment",
  "github.review",
  "github.label",
  "checkout.update",
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export function isIssueEvent(kind: EventKind): boolean {
  return kind.startsWith("issue.");
}

export function supportsIssueEvents(action: ActionKind): boolean {
  return action !== "bb.review" && action !== "github.review";
}

export const CONDITION_FIELDS = [
  "base",
  "head",
  "actor",
  "label",
  "draft",
  "path",
  "event",
  "repository",
] as const;
export type ConditionField = (typeof CONDITION_FIELDS)[number];

export const CONDITION_OPERATORS = ["equals", "not_equals", "matches", "contains"] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

export const JOB_STATUSES = [
  "queued",
  "running",
  "pending_approval",
  "succeeded",
  "skipped",
  "dead_letter",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const DEFAULT_AUTOMATION_LABEL = "bb-automation";

export interface AutomationRepository {
  /** Canonical lower-case owner/name. */
  repo: string;
  /** Automation polling and rule matching is on for this repository. */
  enabled: boolean;
  /** Branch whose pushes raise `push.base` and that `checkout.update` fast-forwards. */
  baseBranch: string;
  projectId: string | null;
  /** Local checkout used by `checkout.update`; null for manually tracked repos. */
  checkoutPath: string | null;
}

export interface RuleCondition {
  id: string;
  field: ConditionField;
  operator: ConditionOperator;
  value: string;
}

export interface RuleConditionGroup {
  id: string;
  combinator: "and" | "or";
  conditions: RuleCondition[];
}

export interface RuleActionParameters {
  reviewPrompt?: string;
  agentPrompt?: string;
  bodyTemplate?: string;
  targetBranch?: string;
  label?: string;
}

export interface RuleExecution {
  providerId: string;
  model: string;
  reasoningLevel: string;
  serviceTier?: string;
}

export interface RuleFilters {
  base?: string;
  head?: string;
  actor?: string;
  labels?: string[];
  draft?: boolean;
  paths?: string[];
}

export interface AutomationRule {
  id: string;
  name: string;
  enabled: boolean;
  order: number;
  events: EventKind[];
  /** Canonical repository names; empty matches every enabled repository. */
  repos: string[];
  filters: RuleFilters;
  conditionGroups: RuleConditionGroup[];
  actions: ActionKind[];
  actionParameters: RuleActionParameters;
  /** Omitted to inherit the repository project's agent defaults. */
  execution?: RuleExecution;
  approvalRequired: boolean;
}

export interface NormalisedEvent {
  deliveryId: string;
  kind: EventKind;
  repo: string;
  actor: string;
  base: string;
  head: string;
  draft: boolean;
  labels: string[];
  files: string[];
  prNumber?: number;
  issueNumber?: number;
  sha?: string;
  title: string;
  payload: Record<string, unknown>;
}

export interface JobActionRun {
  ruleId: string;
  ruleName: string;
  actionIndex: number;
  actionKind: ActionKind;
  status: "running" | "succeeded" | "failed";
  output: string | null;
  updatedAt: string;
}

export interface JobRecord {
  id: number;
  deliveryId: string;
  repo: string;
  kind: EventKind;
  prNumber: number | null;
  issueNumber: number | null;
  title: string;
  status: JobStatus;
  attempts: number;
  approved: boolean;
  error: string | null;
  matchedRules: string[];
  actions: JobActionRun[];
  createdAt: string;
  updatedAt: string;
}

export interface AuditRecord {
  id: number;
  createdAt: string;
  kind: string;
  subject: string;
  outcome: string;
  detail: string;
}

export interface PollRepositoryStatus {
  repo: string;
  lastPolledAt: string | null;
  lastError: string | null;
  lastQueued: number;
}

export interface PollStatus {
  enabled: boolean;
  intervalSeconds: number;
  inProgress: boolean;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastError: string | null;
  lastQueued: number;
  nextAt: string | null;
  autoPaused: boolean;
  quotaPauseRemaining: number;
  resumeAt: string | null;
  repositories: PollRepositoryStatus[];
}

export interface GithubQuotaBucket {
  limit: number;
  remaining: number;
  used: number;
  resetAt: string;
}

export interface GithubQuota {
  available: boolean;
  login: string | null;
  checkedAt: string | null;
  error: string | null;
  graphql: (GithubQuotaBucket & { cost: number }) | null;
  rest: GithubQuotaBucket | null;
}

export interface AutomationDashboard {
  dryRun: boolean;
  repositories: AutomationRepository[];
  enabledRepositoryCount: number;
  rules: AutomationRule[];
  jobs: JobRecord[];
  pendingApprovals: number;
  audit: AuditRecord[];
  poll: PollStatus;
  quota: GithubQuota;
}

export const STARTER_RULES: AutomationRule[] = [
  {
    id: "review-opened",
    name: "Review opened and updated pull requests",
    enabled: false,
    order: 10,
    events: ["pr.opened", "pr.synchronised", "pr.review_requested"],
    repos: [],
    filters: { draft: false },
    conditionGroups: [],
    actions: ["bb.review", "github.review"],
    actionParameters: { bodyTemplate: "{{review}}" },
    approvalRequired: true,
  },
  {
    id: "merged-update",
    name: "Update the local checkout after a merge",
    enabled: false,
    order: 20,
    events: ["pr.merged"],
    repos: [],
    filters: {},
    conditionGroups: [],
    actions: ["checkout.update"],
    actionParameters: {},
    approvalRequired: true,
  },
  {
    id: "base-push-update",
    name: "Update the local checkout after a push to the base branch",
    enabled: false,
    order: 30,
    events: ["push.base"],
    repos: [],
    filters: {},
    conditionGroups: [],
    actions: ["checkout.update"],
    actionParameters: {},
    approvalRequired: true,
  },
];

export const EVENT_LABELS: Record<EventKind, { label: string; description: string }> = {
  "issue.opened": { label: "Issue opened", description: "A new issue is opened." },
  "issue.edited": { label: "Issue edited", description: "An issue's title or description changes." },
  "issue.closed": { label: "Issue closed", description: "An issue is closed." },
  "issue.reopened": { label: "Issue reopened", description: "A closed issue is reopened." },
  "issue.labeled": { label: "Issue labeled", description: "One or more labels are added to an issue." },
  "issue.unlabeled": { label: "Issue unlabeled", description: "One or more labels are removed from an issue." },
  "issue.assigned": { label: "Issue assigned", description: "One or more assignees are added to an issue." },
  "issue.unassigned": { label: "Issue unassigned", description: "One or more assignees are removed from an issue." },
  "pr.opened": { label: "PR opened", description: "A pull request is opened." },
  "pr.synchronised": { label: "PR updated", description: "New commits land on a pull request." },
  "pr.review_requested": { label: "Review requested", description: "A review is requested on a pull request." },
  "pr.approved": { label: "PR approved", description: "A review approves a pull request." },
  "pr.changes_requested": { label: "Changes requested", description: "A review requests changes on a pull request." },
  "ci.success": { label: "CI succeeded", description: "Checks finish successfully." },
  "ci.failure": { label: "CI failed", description: "Checks finish with a failure." },
  "pr.merged": { label: "PR merged", description: "A pull request is merged." },
  "pr.closed": { label: "PR closed", description: "A pull request is closed without merging." },
  "push.base": { label: "Push to base branch", description: "Commits land on the repository's base branch." },
};

export const ACTION_LABELS: Record<
  ActionKind,
  {
    label: string;
    description: string;
    parameter: keyof RuleActionParameters | null;
  }
> = {
  "bb.review": {
    label: "BB agent review",
    description: "Start a GitHub+ review thread in an isolated BB worktree and wait for its findings.",
    parameter: "reviewPrompt",
  },
  "bb.agent": {
    label: "Run agent",
    description: "Run your instructions with the event context in an isolated BB worktree.",
    parameter: "agentPrompt",
  },
  "github.comment": {
    label: "Comment on issue or PR",
    description: "Post a conversation comment on the issue or pull request.",
    parameter: "bodyTemplate",
  },
  "github.review": {
    label: "Post PR review",
    description: "Submit a review comment on the pull request.",
    parameter: "bodyTemplate",
  },
  "github.label": {
    label: "Add label",
    description: `Apply a label to the issue or pull request (default ${DEFAULT_AUTOMATION_LABEL}).`,
    parameter: "label",
  },
  "checkout.update": {
    label: "Update local checkout",
    description: "Fast-forward the base branch in the attached BB project checkout.",
    parameter: "targetBranch",
  },
};

export const CONDITION_FIELD_LABELS: Record<ConditionField, { label: string; placeholder: string }> = {
  base: { label: "Base branch", placeholder: "main" },
  head: { label: "Head branch", placeholder: "feature/*" },
  actor: { label: "Actor", placeholder: "octocat" },
  label: { label: "Label", placeholder: "needs-review" },
  draft: { label: "Draft", placeholder: "true or false" },
  path: { label: "Changed path", placeholder: "src/*" },
  event: { label: "Event kind", placeholder: "pr.opened" },
  repository: { label: "Repository", placeholder: "owner/name" },
};

export const OPERATOR_LABELS: Record<ConditionOperator, string> = {
  equals: "is",
  not_equals: "is not",
  matches: "matches",
  contains: "contains",
};

export const JOB_STATUS_LABELS: Record<
  JobStatus,
  { label: string; tone: "default" | "success" | "warning" | "danger" | "info" }
> = {
  queued: { label: "Queued", tone: "info" },
  running: { label: "Running", tone: "info" },
  pending_approval: { label: "Needs approval", tone: "warning" },
  succeeded: { label: "Succeeded", tone: "success" },
  skipped: { label: "No matching rule", tone: "default" },
  dead_letter: { label: "Failed", tone: "danger" },
};

export const TEMPLATE_PLACEHOLDERS = [
  "{{review}}",
  "{{agent}}",
  "{{repo}}",
  "{{owner}}",
  "{{name}}",
  "{{prNumber}}",
  "{{issueNumber}}",
  "{{number}}",
  "{{title}}",
  "{{event}}",
  "{{base}}",
  "{{head}}",
  "{{actor}}",
  "{{sha}}",
] as const;

/** Expand placeholders once, preserving the literal contents of agent output. */
export function renderTemplate(template: string, event: NormalisedEvent, review: string, agent = ""): string {
  const [owner = "", name = ""] = event.repo.split("/");
  const values: Record<string, string> = {
    review, agent, repo: event.repo, owner, name,
    prNumber: event.prNumber === undefined ? "" : String(event.prNumber),
    issueNumber: event.issueNumber === undefined ? "" : String(event.issueNumber),
    number: String(event.issueNumber ?? event.prNumber ?? ""),
    title: event.title, event: event.kind, base: event.base, head: event.head,
    actor: event.actor, sha: event.sha ?? "",
  };
  return template.replace(/\{\{(\w+)\}\}/g, (placeholder: string, key: string) =>
    Object.hasOwn(values, key) ? values[key]! : placeholder,
  );
}
