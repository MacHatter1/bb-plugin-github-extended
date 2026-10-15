# GitHub Extended

GitHub Extended adds a **GitHub+** panel to BB for working with GitHub issues,
pull requests, Dependabot alerts, pull-request automation, and agent threads
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
- Automate pull-request workflows: poll enabled repositories with `gh`, match
  ordered rules against PR, review, CI, and base-branch events, and run
  approval-gated actions such as agent reviews, GitHub comments and reviews,
  labels, and fast-forward checkout updates. See [Automation](#automation).
- Let agents create automation rules from chat with the
  `github_extended_create_rule` tool and the bundled `github-automation` skill.

## Requirements

- BB with local plugin support.
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
and the **Automation dry run** setting is turned off. The only local write an
automation action can make is a fast-forward-only `git pull` of a repository's
base branch in its attached BB project checkout, and only when a rule includes
that action. The plugin has no delete-repository, fork-deletion, or other
destructive filesystem operation.

Starting work from an issue creates an agent thread in the attached BB project
checkout, or in the configured default project, and that agent may edit files.
Reviewing a pull request creates a separate BB managed worktree. GitHub issue,
pull-request, comment, diff, filename, and code content is untrusted data; the
review prompt tells the agent not to treat it as instructions. The review agent
still runs with BB's supported `accept-edits` mode in that isolated worktree,
so inspect and reject changes before accepting them and do not assume the
prompt alone is an enforcement boundary. The plugin does not push changes or
post GitHub comments as part of starting either action.

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
rules and jobs on the **Automation** tab.

```sh
bb plugin config github-extended set automationDryRun false
```

## Automation

The **Automation** tab turns pull-request activity into approval-gated jobs
without a webhook or public tunnel. Its pages are URL-backed
(`automation`, `automation/rules`, `automation/events`, `automation/audit`,
`automation/polling`).

### Setup

1. **Enable a repository.** Every tracked repository is listed on the Setup
   page with an automation toggle and a base branch (default `main`). Only
   enabled repositories are polled.
2. **GitHub CLI.** Polling and GitHub actions use the same `gh` login as the
   rest of the plugin.
3. **Polling.** `gh pr list` runs for each enabled repository on a timer
   (1 minute to 1 hour, default 5 minutes). The first poll of a repository
   stores a baseline and does not replay existing pull requests.
4. **Rules.** Enable a starter rule or build your own.

### Events

Each poll diffs the current pull requests and base-branch SHA against the
stored snapshot and raises:

`pr.opened`, `pr.synchronised` (new head commit), `pr.review_requested`,
`pr.approved`, `pr.changes_requested`, `ci.success`, `ci.failure`,
`pr.merged`, `pr.closed`, and `push.base` (the base branch SHA changed).

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
| `bb.review` | Starts the same isolated GitHub+ review thread as **Review with agent**, links it to the PR, waits for the agent to go idle, and captures its output for later actions. | `reviewPrompt` (extra trusted instructions) |
| `github.comment` | Posts a conversation comment on the PR. | `bodyTemplate` |
| `github.review` | Posts a review comment on the PR. | `bodyTemplate` |
| `github.label` | Adds a label to the PR (default `bb-automation`). | `label` |
| `checkout.update` | Fast-forwards the base branch in the attached BB project checkout with `git pull --ff-only`; refuses if the checkout is on another branch. | `targetBranch` |

Body templates accept `{{review}}`, `{{repo}}`, `{{owner}}`, `{{name}}`,
`{{prNumber}}`, `{{title}}`, `{{event}}`, `{{base}}`, `{{head}}`, `{{actor}}`,
and `{{sha}}`. Changed-path filters fetch the PR file list only when a rule
uses them.

### Jobs, approvals, and audit

Every detected event becomes one durable job. The worker matches rules in
order; a job that matches an approval-gated rule waits on the Events page
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
