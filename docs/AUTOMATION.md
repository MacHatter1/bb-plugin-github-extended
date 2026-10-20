# Automation guide

[Back to the README](../README.md)

GitHub+ has three main destinations:

- **Inbox** combines issues, pull requests, security alerts, and pending approvals.
  It starts on **Needs attention**: open issues/PRs, approvals, and open high or
  critical security alerts. **Everything** includes other cached states and
  lower-priority alerts. Type filters and search narrow the queue. Detailed
  search and existing saved views remain under **Advanced search and saved views**.
  Each section uses 25-row pages, with 50- and 100-row options and page controls
  above and below the list. Search and filter changes return to the first page.
- **Automations** lists saved rules with immediate on/off switches. **Create
  automation** opens a native agent composer: describe the trigger and action,
  and the agent saves a disabled, approval-required draft for review. **Build
  manually** is also available. The compact editor shows Repository, When,
  Conditions, Action, and Approval; multiple triggers/actions, AND/OR groups,
  templates, and JSON remain under **Advanced**. Concurrent edits are detected
  before saving so a stale draft cannot overwrite newer rules.
- **Activity** shows automation runs and linked agent conversations. Expand a
  run for action output and audit details. Approvals can be handled here or in
  Inbox. Runs and pending approvals use the same pagination as Inbox. Pending
  approvals remain visible even after newer runs accumulate.

One persistent repository scope filters all three destinations. **Settings**
contains tracked repositories; **Advanced automation settings** leads to
repository automation enablement, polling, and quota controls. Existing issue,
PR, security-alert, and advanced automation URLs continue to work. The root
panel opens Inbox, `automation` opens saved rules, `automation/create` opens
creation, and `activity` opens the run history.

## Setup

1. **Enable a repository.** Every tracked repository is listed under Settings →
   Advanced automation settings → Repository automation with an automation toggle and a base branch (default `main`). Only
   enabled repositories are polled.
2. **GitHub CLI.** Polling and GitHub actions use the same `gh` login as the
   rest of the plugin.
3. **Polling.** `gh issue list` and `gh pr list` run for each enabled repository on a timer
   (1 minute to 1 hour, default 5 minutes). The first poll of a repository
   stores a baseline and does not replay existing issues or pull requests.
4. **Rules.** Enable a starter rule or build your own.

## Events

Each poll diffs the current issues, pull requests, and base-branch SHA against the
stored snapshot and raises:

`pr.opened`, `pr.synchronised` (new head commit), `pr.review_requested`,
`pr.approved`, `pr.changes_requested`, `ci.success`, `ci.failure`,
`pr.merged`, `pr.closed`, and `push.base` (the base branch SHA changed).

Issue triggers are `issue.opened`, `issue.edited` (title or description),
`issue.closed`, `issue.reopened`, `issue.labeled`, `issue.unlabeled`,
`issue.assigned`, and `issue.unassigned`. Labels and assignments report changes
observed between polls. New comments alone do not emit an issue event. The issue
author is the actor; polling does not identify who made an edit or assignment.

Issue polling has its own baseline, so upgrading does not replay existing issues
or reset PR polling. Disabling a repository resets both baselines. Each issue
poll reads up to 100 recently updated open issues and 50 recently updated closed
issues. Changes outside that window, or changes undone between polls, can be
missed. An issue polling failure is reported without blocking PR events.

Stable delivery IDs prevent duplicates when the same observed transition is processed again.

## Rules

A rule has a name, enabled state, order, one or more trigger events, an
optional repository list (empty means every enabled repository), flat filters
(base/head branch wildcards, actor, labels, draft, changed paths), condition
groups (every group must match; rows within a group combine with AND or OR
over base, head, actor, label, draft, path, event, and repository), and an
ordered action list. Rules can also be edited as JSON.

Actions:

| Action | What it does | Parameter |
| --- | --- | --- |
| `bb.review` | Starts an isolated GitHub+ review thread, links it to the PR, waits for the agent to go idle, and captures its output for later actions. | `reviewPrompt` (extra trusted instructions) |
| `bb.agent` | Runs your instructions with event context in an isolated BB worktree, waits for the agent to go idle, and captures its output. Works with issues, PR events, and base-branch pushes. | `agentPrompt` (required) |
| `github.comment` | Posts a conversation comment on the issue or PR. | `bodyTemplate` |
| `github.review` | Posts a review comment on the PR. | `bodyTemplate` |
| `github.label` | Adds a label to the issue or PR (default `bb-automation`). | `label` |
| `checkout.update` | Fast-forwards the base branch in the attached BB project checkout with `git pull --ff-only`; refuses if the checkout is on another branch. | `targetBranch` |

Body templates accept `{{review}}`, `{{agent}}`, `{{repo}}`, `{{owner}}`, `{{name}}`,
`{{prNumber}}`, `{{issueNumber}}`, `{{number}}` (either item type), `{{title}}`, `{{event}}`, `{{base}}`, `{{head}}`, `{{actor}}`,
and `{{sha}}`. Changed-path filters fetch the PR file list only when a rule
uses them.

Issue triggers work with agent tasks, comments, labels, and checkout updates.
The builder removes PR-only review actions when you select an issue trigger;
JSON edits and agent-created rules reject those combinations. Put PR review
actions in a separate rule. Branch and changed-path filters apply to PRs;
issue events have no branches or changed files.

For a custom action, expand an automation and choose **Ask agent (something else…)**
from Action. The multi-action editor under Advanced also offers **Something else?**.
Describe what the agent should do, then save the rule. For example: “Investigate
the failing CI checks, fix the cause, and open a pull request.” The action uses
the attached project's default provider and model (or the configured default
project), with BB's `accept-edits` permission mode and a separate managed
worktree based on the project's default branch. The agent receives the PR
or issue number, branches, SHA, actor, labels, and other event fields as untrusted data;
your saved instructions are kept separate and are not template-expanded.
Ask it to inspect or check out the relevant PR or commit when the action needs
to work on that revision. Instructions cannot grant additional permissions.

Custom actions use the same approval and dry-run settings as other actions.
Dry run records the instructions without starting an agent. Agent threads
remain visible in BB, issue and PR events link the thread to the matching item, and the audit trail
records its ID. A later comment or review action can use `{{agent}}` to post the
latest preceding custom agent's response. An agent has up to 30 minutes to go
idle; a failed wait stops it and the normal job retry policy applies. Actions
that change external state should check whether their work is already done
before repeating it.

## Jobs, approvals, and audit

Every detected event becomes one durable job. The worker matches rules in
order; a job that matches an approval-gated rule waits in Inbox and Activity
until you approve it. Actions are keyed by job, rule, and position, so a
replay never repeats a completed action. Failures retry up to three attempts
before the job enters the dead-letter state, from which it can be replayed.
Stale `running` jobs left behind by a restart can be requeued. Every poll,
rule save, job transition, and action run is appended to the audit trail.

## Quota

The Polling page reads the GitHub GraphQL and REST quota through `gh`. Polling
pauses automatically when GraphQL points remaining fall to the configured floor
(default 100) and resumes after GitHub resets the hourly quota. Polling and other `gh` commands share the signed-in account's API quota,
including the plugin's own sync.

## Creating rules from chat

Agents get the `github_extended_create_rule` tool and the `github-automation`
skill. Ask for a rule in natural language; the tool creates it disabled and
approval-gated for the repository attached to the current BB project (or an
explicit `repo`), and the reply ends with a result card that opens the Rules
page.
