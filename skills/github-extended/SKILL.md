---
name: github-extended
description: Browse cached GitHub repositories, issues, and pull requests, or inspect automation rules and jobs with the GitHub Extended plugin CLI.
---

# Inspect GitHub+ work

Use `bb github-extended` for this plugin. `bb github` belongs to BB's built-in
GitHub plugin and has separate state. The explicit command form is
`bb plugin run github-extended <command>`.

Read-only commands:

```sh
bb github-extended repos
bb github-extended issues acme/api
bb github-extended prs acme/web
bb github-extended rules
bb github-extended jobs
```

Repository arguments are optional for `issues` and `prs`. They must name a
tracked `owner/repo`. Output is plain text; there is no `--json` flag. Item
lists contain cached open items, and `jobs` returns the latest 50 jobs. Use
GitHub+ Activity to page through older runs for a selected repository.

`bb github-extended sync` refreshes the read-only browsing cache from GitHub.
It uses the signed-in `gh` account and does not enable automation.

`bb github-extended poll` polls enabled automation repositories and queues newly
observed events. Those jobs can run configured actions if enabled rules match,
dry run is off, and any required approval is granted.

`bb github-extended approve <job>` approves and queues a job waiting for approval
or replay. Run it only for the job the user asked to approve; it can release
external writes or agent work. Dry run starts on and records intended actions.

For rule creation, use the bundled `github-automation` skill and
`github_extended_create_rule`, which creates disabled, approval-required drafts
by default. Do not invent CLI rule-creation or editing commands.

When a repository is missing, check its BB project GitHub origin or the
`extraRepos` setting. If GitHub access is unavailable, inspect
`gh auth status --hostname github.com` and the repository health shown in
GitHub+ Settings. Automation setup is under Settings → Advanced automation settings.
