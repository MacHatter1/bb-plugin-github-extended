import { createHash } from "node:crypto";
import { z } from "zod";
import type { EventKind, NormalisedEvent } from "./domain.js";
import { pollDeliveryId } from "./poller.js";

export const ISSUE_POLL_JSON_FIELDS = "number,title,body,state,author,labels,assignees,createdAt,updatedAt,closedAt";

const issueSnapshotSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  bodyHash: z.string(),
  state: z.enum(["OPEN", "CLOSED"]),
  actor: z.string(),
  labels: z.array(z.string()),
  assignees: z.array(z.string()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  closedAt: z.string().datetime().nullable(),
});

const issuePollSnapshotSchema = z.object({
  observedAt: z.string().datetime(),
  issues: z.record(z.string(), issueSnapshotSchema),
});
export type IssuePollSnapshot = z.output<typeof issuePollSnapshotSchema>;

const ghIssueSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.enum(["OPEN", "CLOSED"]),
  author: z.object({ login: z.string() }).nullable(),
  labels: z.array(z.object({ name: z.string() })),
  assignees: z.array(z.object({ login: z.string() })),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  closedAt: z.string().datetime().nullable(),
}).transform(({ body, author, labels, assignees, ...issue }) => ({
  ...issue,
  bodyHash: createHash("sha256").update(body ?? "").digest("hex"),
  actor: author?.login ?? "",
  labels: [...new Set(labels.map((label) => label.name))].sort(),
  assignees: [...new Set(assignees.map((assignee) => assignee.login))].sort(),
}));

export function issueObservationFromPoll(outputs: string[], observedAt: string): IssuePollSnapshot {
  const issues: IssuePollSnapshot["issues"] = {};
  for (const output of outputs) {
    for (const issue of z.array(ghIssueSchema).parse(JSON.parse(output))) {
      const previous = issues[String(issue.number)];
      if (!previous || issue.updatedAt >= previous.updatedAt) issues[String(issue.number)] = issue;
    }
  }
  return { observedAt, issues };
}

export function parseIssueSnapshot(raw: string | null): IssuePollSnapshot | null {
  if (!raw) return null;
  try {
    const result = issuePollSnapshotSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** An independent baseline lets existing PR polling adopt issue support without replaying old issues. */
export function diffIssueObservation(previous: IssuePollSnapshot | null, current: IssuePollSnapshot, repo: string): NormalisedEvent[] {
  if (!previous) return [];
  const events: NormalisedEvent[] = [];
  // GitHub timestamps can have second precision; the local poll start has milliseconds.
  const since = Math.floor(Date.parse(previous.observedAt) / 1_000) * 1_000;
  for (const issue of Object.values(current.issues)) {
    const before = previous.issues[String(issue.number)];
    const addedLabels = issue.labels.filter((label) => !before?.labels.includes(label));
    const removedLabels = before?.labels.filter((label) => !issue.labels.includes(label)) ?? [];
    const addedAssignees = issue.assignees.filter((assignee) => !before?.assignees.includes(assignee));
    const removedAssignees = before?.assignees.filter((assignee) => !issue.assignees.includes(assignee)) ?? [];
    const revision = createHash("sha256").update(JSON.stringify(issue)).digest("hex").slice(0, 24);
    const emit = (kind: EventKind) => events.push({
      deliveryId: pollDeliveryId(repo, kind, `${issue.number}:${kind === "issue.opened" ? "created" : revision}`),
      kind, repo, actor: issue.actor, base: "", head: "", draft: false,
      labels: issue.labels, files: [], issueNumber: issue.number, title: issue.title,
      payload: {
        issue: {
          number: issue.number, title: issue.title, state: issue.state.toLowerCase(),
          user: { login: issue.actor }, labels: issue.labels.map((name) => ({ name })),
          assignees: issue.assignees.map((login) => ({ login })),
        },
        changes: { addedLabels, removedLabels, addedAssignees, removedAssignees },
      },
    } satisfies NormalisedEvent);
    if (!before) {
      if (issue.state === "OPEN" && Date.parse(issue.createdAt) >= since) emit("issue.opened");
      else if (issue.state === "CLOSED" && issue.closedAt && Date.parse(issue.closedAt) >= since) emit("issue.closed");
      continue;
    }
    if (before.title !== issue.title || before.bodyHash !== issue.bodyHash) emit("issue.edited");
    if (before.state !== issue.state) emit(issue.state === "CLOSED" ? "issue.closed" : "issue.reopened");
    if (addedLabels.length > 0) emit("issue.labeled");
    if (removedLabels.length > 0) emit("issue.unlabeled");
    if (addedAssignees.length > 0) emit("issue.assigned");
    if (removedAssignees.length > 0) emit("issue.unassigned");
  }
  return events;
}
