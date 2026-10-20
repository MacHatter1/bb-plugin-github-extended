# GitHub Extended

GitHub Extended adds a **GitHub+** panel to BB for working with GitHub issues,
pull requests, Dependabot alerts, GitHub automation, and agent threads
from one workspace.

The plugin is available as `github-extended` so it can coexist with BB's
built-in `github` plugin without a CLI command collision.

## Features

- Discover repositories from the `origin` remotes of local BB project sources.
- Track additional repositories with the `extraRepos` setting.
- Browse open and recently closed issues and pull requests from a local cache.
- Filter, search, and save named views for issues, pull requests, and Dependabot.
- View issue discussions, pull request checks, reviews, comments, and diffs.
- Create issues and comment, close/reopen, assign, and relabel items.
- Start BB agent work from an issue or request an agent review of a pull request.
- Link a pull request to an existing BB thread.
- Use GitHub issues and pull requests as BB mention providers with `@` and `#`.
- Refresh automatically every five minutes, with retry/backoff for transient failures.
- Automate issue and pull-request workflows: poll enabled repositories with `gh`, match
  ordered rules against PR, review, CI, and base-branch events, and run
  approval-gated actions such as agent reviews, GitHub comments and reviews,
  labels, and fast-forward checkout updates. See [Automation](#automation).
- Describe custom automation actions with **Something else?** and have a BB
  agent carry them out for each matching event.
- Let agents create automation rules from chat with the
  `github_extended_create_rule` tool and the bundled `github-automation` skill.

## Requirements

- BB with plugin SDK 0.6.49 or newer.
- The [GitHub CLI](https://cli.github.com/) (`gh`).
- An authenticated GitHub CLI session for `github.com`:

  ```sh
  gh auth login
  gh auth status --hostname github.com
  ```

The authenticated account must be able to read the repositories you track and
must have the GitHub permissions required for any mutations you use. Dependabot
alerts must be enabled for a repository and may require additional GitHub
permissions. If Dependabot is unavailable for one repository, GitHub+ shows the
repository-specific reason while the rest of the plugin remains usable.

GitHub Enterprise remotes are not currently discovered; repository remotes and
authentication target `github.com`.

## Permissions and data boundaries

The plugin uses the installed `gh` executable for GitHub API reads and writes;
it does not manage a separate GitHub token or call a second GitHub client. The
authenticated `gh` account therefore controls the repositories and mutations
available to the plugin. Creating issues, posting comments, changing state,
assigning users, and changing labels require the matching GitHub permissions.

Dependabot alerts are a separate GitHub capability. Alerts must be enabled for
each repository. GitHub CLI credentials need the `security_events` scope to
read alerts. If the alerts endpoint reports a missing scope, refresh it with:

```sh
gh auth refresh -h github.com -s security_events
```

For repository discovery, the server reads the `origin` remote from local BB
project checkouts. It writes synchronized items, health, and thread links to
the plugin's local SQLite cache. Cache contents are not sent to a separate
telemetry service by the plugin.

The five-minute background refresh is read-only, and so is automation polling.
No agent thread is started and no GitHub mutation is performed until a rule
you enabled matches an event, the job is approved when the rule requires it,
and the **Automation dry run** setting is turned off. The `checkout.update`
action uses a fast-forward-only `git pull` of a repository's base branch in its
attached BB project checkout. Custom `bb.agent` actions can edit files in an
isolated worktree and carry out external changes explicitly requested by the
saved instructions, subject to BB's agent permissions.

**Ask agent** opens BB's native composer with Investigate, Fix, or Review
suggestions. The attached repository project is selected when available, with
a separate managed worktree and `accept-edits` seeded for item tasks. You can
change the project, environment, model, and permissions before sending. GitHub
text and command output are supplied as untrusted context. Starting a task does
not itself push or post to GitHub. Item conversations are linked back to the
issue, PR, or security alert and appear in Activity.

## Install from this checkout

Build the plugin, then install the local checkout into BB:

```sh
npm install
npm run build
bb plugin install --yes /absolute/path/to/bb-github-extended
bb plugin enable github-extended
bb plugin reload github-extended
```

Confirm that it is running:

```sh
bb plugin list
bb github-extended --help
```

For an already installed development checkout, rebuild and reload it:

```sh
npm run build
bb plugin reload github-extended
```

Open the **GitHub+** panel in BB. The plugin's explicit command form is also
always available:

```sh
bb plugin run github-extended <command>
```

## Configuration

Open the GitHub+ plugin settings in BB.

### Extra repositories

`Extra repositories` is a comma-separated list of GitHub repository names to
track in addition to repositories discovered from BB projects:

```text
acme/api, acme/web
```

The same setting can be changed from the CLI:

```sh
bb plugin config github-extended set extraRepos "acme/api,acme/web"
```

Repository names must use the `owner/repository` format. Invalid entries are
ignored and reported in the plugin log.

### Default BB project

`Default BB project` selects where an agent thread is created when a manually
tracked repository is not attached to a discovered BB project. Set it in the
plugin settings before using the agent actions for those repositories.

### Automation dry run

`Automation dry run` is on by default. While it is on, matched automation jobs
record what each action would have done instead of posting to GitHub, starting
review threads, or updating checkouts. Turn it off only after reviewing the
rules in **Automations** and jobs in **Activity**.

```sh
bb plugin config github-extended set automationDryRun false
```

## Automation

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

### Setup

1. **Enable a repository.** Every tracked repository is listed under Settings →
   Advanced automation settings → Repository automation with an automation toggle and a base branch (default `main`). Only
   enabled repositories are polled.
2. **GitHub CLI.** Polling and GitHub actions use the same `gh` login as the
   rest of the plugin.
3. **Polling.** `gh issue list` and `gh pr list` run for each enabled repository on a timer
   (1 minute to 1 hour, default 5 minutes). The first poll of a repository
   stores a baseline and does not replay existing issues or pull requests.
4. **Rules.** Enable a starter rule or build your own.

### Events

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

Delivery ids are stable, so the same transition is never queued twice.

### Rules

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

### Jobs, approvals, and audit

Every detected event becomes one durable job. The worker matches rules in
order; a job that matches an approval-gated rule waits in Inbox and Activity
until you approve it. Actions are keyed by job, rule, and position, so a
replay never repeats a completed action. Failures retry up to three attempts
before the job enters the dead-letter state, from which it can be replayed.
Stale `running` jobs left behind by a restart can be requeued. Every poll,
rule save, job transition, and action run is appended to the audit trail.

### Quota

The Polling page reads the GitHub GraphQL and REST quota through `gh`. Polling
pauses automatically when GraphQL points remaining fall to the configured floor
(default 100) and resumes after GitHub resets the hourly quota. `gh pr list
--json` shares the signed-in user's 5,000 GraphQL points per hour with every
other `gh` command on the machine, including the plugin's own sync.

### Creating rules from chat

Agents get the `github_extended_create_rule` tool and the `github-automation`
skill. Ask for a rule in natural language; the tool creates it disabled and
approval-gated for the repository attached to the current BB project (or an
explicit `repo`), and the reply ends with a result card that opens the Rules
page.

## CLI commands

All list commands read the plugin's synchronized cache. Use `sync` to request a
fresh refresh from GitHub.

```text
bb github-extended repos               List tracked repositories
bb github-extended issues [owner/repo]  List cached open issues
bb github-extended prs [owner/repo]     List cached open pull requests
bb github-extended sync                Refresh the cache from GitHub now
bb github-extended rules               List automation rules
bb github-extended jobs                List recent automation events and jobs
bb github-extended poll                Poll GitHub for automation events now
bb github-extended approve <job>       Approve a job waiting for approval
```

## Data and synchronization

The server stores synchronized issue, pull request, Dependabot, health, and
thread-link data in the plugin's local SQLite cache, alongside automation
repositories, rules, poll snapshots, jobs, action runs, and the audit trail.
The panel and mention providers read that cache so browsing does not require a
GitHub request for every view.

Actions that change GitHub data—such as creating an issue, posting a comment,
changing state, assigning users, or changing labels—run through the GitHub CLI
and require the corresponding GitHub permission. Repository health displays
whether synchronization is healthy, partial, failed, or has not run yet.

## Running alongside BB's built-in GitHub plugin

GitHub Extended uses the command `bb github-extended`; BB's built-in plugin uses
`bb github`. Their storage and panel routes are namespaced separately, so they
do not overwrite one another. Enabling both can still produce duplicate GitHub
panels, mention suggestions, background synchronization, and API traffic.

For a single GitHub experience, keep the built-in `github` plugin disabled when
using GitHub Extended.

## Troubleshooting

### GitHub CLI is unavailable or unauthenticated

Run:

```sh
gh auth status --hostname github.com
bb plugin reload github-extended
```

If `gh` is not installed, install it from [cli.github.com](https://cli.github.com/)
and run `gh auth login`.

### A repository is missing

Check that its local BB project source has a GitHub `origin` remote, or add the
repository explicitly through `Extra repositories`. Then run:

```sh
bb github-extended sync
```

### Dependabot shows a permission or disabled-alert error

Dependabot alerts are controlled by GitHub per repository. Enable Dependabot
alerts where appropriate. If the error reports a missing `security_events`
scope, run `gh auth refresh -h github.com -s security_events`, then reload or
synchronize the plugin after changing access.

### Inspect plugin logs

```sh
bb plugin logs github-extended -n 50
```

GitHub content is treated as untrusted input. Review agent changes in BB before
accepting them, and confirm the target project before starting agent work.

## Development

The authoritative source is under `src/`; `dist/` is generated and should be
rebuilt before packaging.

```sh
npm install
npm run build
npm run typecheck
npm test
npm run check:package
npm pack --dry-run
```

`check:package` verifies source and generated-output parity, plugin metadata,
the canonical package contents, and an isolated packed-consumer install.

## License

MIT
