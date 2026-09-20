// Zod schemas for automation rules, jobs, and the RPC methods the panel and
// agent tool use. Types in ./domain.ts are the hand-written mirror.
import { z } from "zod";
import {
  ACTION_KINDS,
  CONDITION_FIELDS,
  CONDITION_OPERATORS,
  EVENT_KINDS,
  JOB_STATUSES,
} from "./domain.js";
import {
  POLL_INTERVAL_MAX_SECONDS,
  POLL_INTERVAL_MIN_SECONDS,
  QUOTA_PAUSE_MAX,
  QUOTA_PAUSE_MIN,
} from "./poller.js";

export const AUTOMATION_REPO_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$/;

export const automationRepoNameSchema = z
  .string()
  .regex(AUTOMATION_REPO_PATTERN, "expected owner/repo")
  .transform((value) => value.toLowerCase());

export const branchNameSchema = z
  .string()
  .min(1)
  .max(250)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.startsWith("-") &&
      !value.endsWith("/") &&
      !value.includes("..") &&
      !value.includes("//") &&
      !/[\s~^:?*[\\]/.test(value),
    "Invalid branch name",
  );

const conditionSchema = z
  .object({
    id: z.string().min(1).max(100),
    field: z.enum(CONDITION_FIELDS),
    operator: z.enum(CONDITION_OPERATORS),
    value: z.string().max(500),
  })
  .strict();

const conditionGroupSchema = z
  .object({
    id: z.string().min(1).max(100),
    combinator: z.enum(["and", "or"]),
    conditions: z.array(conditionSchema).max(30),
  })
  .strict();

const filtersSchema = z
  .object({
    base: z.string().max(250).optional(),
    head: z.string().max(250).optional(),
    actor: z.string().max(100).optional(),
    labels: z.array(z.string().max(100)).max(30).optional(),
    draft: z.boolean().optional(),
    paths: z.array(z.string().max(500)).max(30).optional(),
  })
  .strict();

const actionParametersSchema = z
  .object({
    reviewPrompt: z.string().max(20_000).optional(),
    bodyTemplate: z.string().max(20_000).optional(),
    targetBranch: branchNameSchema.optional(),
    label: z.string().min(1).max(100).optional(),
  })
  .strict();

export const ruleSchema = z
  .object({
    id: z.string().min(1).max(100),
    name: z.string().min(1).max(160),
    enabled: z.boolean(),
    order: z.number().int(),
    events: z.array(z.enum(EVENT_KINDS)).min(1),
    repos: z.array(automationRepoNameSchema).max(100).default([]),
    filters: filtersSchema.default({}),
    conditionGroups: z.array(conditionGroupSchema).max(20).default([]),
    actions: z.array(z.enum(ACTION_KINDS)).min(1),
    actionParameters: actionParametersSchema.default({}),
    approvalRequired: z.boolean().default(false),
  })
  .strict();

export const createRuleInputSchema = ruleSchema
  .omit({ id: true, order: true, repos: true })
  .extend({
    enabled: z.boolean().default(false),
    approvalRequired: z.boolean().default(true),
    repo: automationRepoNameSchema.optional(),
  })
  .strict();

export const automationRepositorySchema = z
  .object({
    repo: automationRepoNameSchema,
    enabled: z.boolean(),
    baseBranch: z.string(),
    projectId: z.string().nullable(),
    checkoutPath: z.string().nullable(),
  })
  .strict();

const jobActionRunSchema = z
  .object({
    ruleId: z.string(),
    ruleName: z.string(),
    actionIndex: z.number().int(),
    actionKind: z.enum(ACTION_KINDS),
    status: z.enum(["running", "succeeded", "failed"]),
    output: z.string().nullable(),
    updatedAt: z.string(),
  })
  .strict();

export const jobSchema = z
  .object({
    id: z.number().int(),
    deliveryId: z.string(),
    repo: z.string(),
    kind: z.enum(EVENT_KINDS),
    prNumber: z.number().int().nullable(),
    title: z.string(),
    status: z.enum(JOB_STATUSES),
    attempts: z.number().int(),
    approved: z.boolean(),
    error: z.string().nullable(),
    matchedRules: z.array(z.string()),
    actions: z.array(jobActionRunSchema),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

export const auditSchema = z
  .object({
    id: z.number().int(),
    createdAt: z.string(),
    kind: z.string(),
    subject: z.string(),
    outcome: z.string(),
    detail: z.string(),
  })
  .strict();

const pollRepositoryStatusSchema = z
  .object({
    repo: z.string(),
    lastPolledAt: z.string().nullable(),
    lastError: z.string().nullable(),
    lastQueued: z.number().int(),
  })
  .strict();

export const pollStatusSchema = z
  .object({
    enabled: z.boolean(),
    intervalSeconds: z.number().int(),
    inProgress: z.boolean(),
    lastStartedAt: z.string().nullable(),
    lastFinishedAt: z.string().nullable(),
    lastError: z.string().nullable(),
    lastQueued: z.number().int(),
    nextAt: z.string().nullable(),
    autoPaused: z.boolean(),
    quotaPauseRemaining: z.number().int(),
    resumeAt: z.string().nullable(),
    repositories: z.array(pollRepositoryStatusSchema),
  })
  .strict();

export const pollRunSchema = z
  .object({
    ran: z.boolean(),
    queued: z.number().int(),
    error: z.string().nullable(),
    intervalSeconds: z.number().int(),
  })
  .strict();

const quotaBucketSchema = z
  .object({
    limit: z.number().int(),
    remaining: z.number().int(),
    used: z.number().int(),
    resetAt: z.string(),
  })
  .strict();

export const quotaSchema = z
  .object({
    available: z.boolean(),
    login: z.string().nullable(),
    checkedAt: z.string().nullable(),
    error: z.string().nullable(),
    graphql: quotaBucketSchema.extend({ cost: z.number().int() }).nullable(),
    rest: quotaBucketSchema.nullable(),
  })
  .strict();

export const dashboardSchema = z
  .object({
    dryRun: z.boolean(),
    repositories: z.array(automationRepositorySchema),
    enabledRepositoryCount: z.number().int(),
    rules: z.array(ruleSchema),
    jobs: z.array(jobSchema),
    pendingApprovals: z.number().int(),
    audit: z.array(auditSchema),
    poll: pollStatusSchema,
    quota: quotaSchema,
  })
  .strict();

/** Spread into the plugin's single `defineRpcContract` call. */
export const automationRpcMethods = {
  automationDashboard: { input: z.null(), output: dashboardSchema },
  automationSetRepository: {
    input: z
      .object({
        repo: automationRepoNameSchema,
        enabled: z.boolean().optional(),
        baseBranch: branchNameSchema.optional(),
      })
      .strict(),
    output: automationRepositorySchema,
  },
  automationSaveRules: {
    input: z.object({ rules: z.array(ruleSchema).max(100) }).strict(),
    output: z.object({ saved: z.number().int() }).strict(),
  },
  automationPollNow: { input: z.null(), output: pollRunSchema },
  automationSetPolling: {
    input: z
      .object({
        enabled: z.boolean().optional(),
        intervalSeconds: z
          .number()
          .int()
          .min(POLL_INTERVAL_MIN_SECONDS)
          .max(POLL_INTERVAL_MAX_SECONDS)
          .optional(),
        quotaPauseRemaining: z.number().int().min(QUOTA_PAUSE_MIN).max(QUOTA_PAUSE_MAX).optional(),
      })
      .strict(),
    output: z
      .object({
        enabled: z.boolean(),
        intervalSeconds: z.number().int(),
        quotaPauseRemaining: z.number().int(),
      })
      .strict(),
  },
  automationQuota: {
    input: z.object({ force: z.boolean().optional() }).strict(),
    output: quotaSchema,
  },
  automationReplayJob: {
    input: z.object({ jobId: z.number().int().positive(), approve: z.boolean() }).strict(),
    output: z.object({ queued: z.boolean() }).strict(),
  },
  automationReconcile: {
    input: z.null(),
    output: z.object({ queued: z.number().int() }).strict(),
  },
};
