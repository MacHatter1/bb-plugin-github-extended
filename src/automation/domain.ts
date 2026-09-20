// Automation domain model shared by the server engine, the panel UI, the
// agent tool, and the CLI. Pure data — no Node or browser imports.

export const EVENT_KINDS = [
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
  "github.comment",
  "github.review",
  "github.label",
  "checkout.update",
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

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
  bodyTemplate?: string;
  targetBranch?: string;
  label?: string;
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
  "github.comment": {
    label: "Comment on PR",
    description: "Post a conversation comment on the pull request.",
    parameter: "bodyTemplate",
  },
  "github.review": {
    label: "Post PR review",
    description: "Submit a review comment on the pull request.",
    parameter: "bodyTemplate",
  },
  "github.label": {
    label: "Add PR label",
    description: `Apply a label to the pull request (default ${DEFAULT_AUTOMATION_LABEL}).`,
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
  dead_letter: { label: "Dead letter", tone: "danger" },
};

export const TEMPLATE_PLACEHOLDERS = [
  "{{review}}",
  "{{repo}}",
  "{{owner}}",
  "{{name}}",
  "{{prNumber}}",
  "{{title}}",
  "{{event}}",
  "{{base}}",
  "{{head}}",
  "{{actor}}",
  "{{sha}}",
] as const;

/** Fill a comment/review body template from an event and the latest review text. */
export function renderTemplate(template: string, event: NormalisedEvent, review: string): string {
  const [owner = "", name = ""] = event.repo.split("/");
  return template
    .replaceAll("{{review}}", review)
    .replaceAll("{{repo}}", event.repo)
    .replaceAll("{{owner}}", owner)
    .replaceAll("{{name}}", name)
    .replaceAll("{{prNumber}}", event.prNumber === undefined ? "" : String(event.prNumber))
    .replaceAll("{{title}}", event.title)
    .replaceAll("{{event}}", event.kind)
    .replaceAll("{{base}}", event.base)
    .replaceAll("{{head}}", event.head)
    .replaceAll("{{actor}}", event.actor)
    .replaceAll("{{sha}}", event.sha ?? "");
}
