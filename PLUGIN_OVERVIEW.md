Keep GitHub work moving, from one BB inbox.

GitHub Extended adds GitHub+ to BB. Browse issues, pull requests, and Dependabot
alerts across repositories, follow the discussion, and keep your agent's work
linked to the item that started it.

## What you get

- **Inbox:** one queue for issues, pull requests, security alerts, and automation
  approvals. Start with Needs attention, search by text, and filter by type or
  repository. Lists offer 25-, 50-, and 100-row pages.
- **Item details:** discussions, PR checks, reviews, and diffs. Create issues,
  comment, close or reopen items, assign people, and edit labels through your
  existing GitHub CLI permissions.
- **Automations:** ordered rules for issue, PR, review, CI, and base-branch
  events. Use the compact builder, Advanced controls, or describe the rule in
  the native composer. New rules created from chat start disabled and require
  approval unless you request otherwise.
- **Custom actions:** choose Ask agent (something else…) and describe the work.
  Built-in actions also support reviews, comments, labels, and fast-forward
  checkout updates.
- **Activity:** inspect outputs and audit details, handle approvals, replay
  jobs, and return to linked conversations. History pages include older runs
  for the selected repository.
- **Ask agent:** investigate, fix, or review an item with BB's native composer.
  Choose the project, environment, model, and permissions before sending.

## Setup and boundaries

Install from `git:https://github.com/MacHatter1/bb-plugin-github-extended`.
Requires BB with Plugin SDK 0.6.49 or newer and GitHub CLI authenticated for
`github.com`. Repositories come from local BB project remotes, with extra
repositories available in settings. GitHub Enterprise remotes are not discovered.

Dry run starts on. Automation only polls repositories you enable; its first
poll records a baseline without replaying existing items. Enabled rules can
start agents or make GitHub changes when dry run is off and any required job
approval is granted. Custom actions run in managed worktrees with `accept-edits`
permissions. Checkout updates fast-forward the configured base branch in the
attached project checkout.

The plugin uses your existing `gh` access and keeps its cache, rules, links,
jobs, and audit trail in local SQLite storage. It does not store a separate
GitHub token. Dependabot visibility depends on repository settings and GitHub
permissions.

The command is `bb github-extended`, separate from BB's built-in `bb github`.
Using both can duplicate panels and background requests. Bundled skills cover
CLI inspection and creating automation rules from chat.

MIT licensed. Screenshots use fictional demo data. See the README and automation
guide for setup, polling limits, retries, and permissions.
