---
name: github-automation
description: Create GitHub+ automation rules from natural-language requests. Use when the user asks to automate issue, pull-request, CI, review, or base-branch actions for a tracked GitHub repository.
---

# GitHub+ automation rules

Use `github_extended_create_rule` to create one rule. When `repo` is omitted, the tool scopes the rule to the GitHub repository attached to the current BB project.

Translate the request into:

- `events`: one or more of `issue.opened`, `issue.edited`, `issue.closed`, `issue.reopened`, `issue.labeled`, `issue.unlabeled`, `issue.assigned`, `issue.unassigned`, `pr.opened`, `pr.synchronised`, `pr.review_requested`, `pr.approved`, `pr.changes_requested`, `ci.success`, `ci.failure`, `pr.merged`, `pr.closed`, or `push.base`.
- `actions`: ordered supported actions: `bb.review`, `bb.agent`, `github.comment`, `github.review`, `github.label`, or `checkout.update`. Use `bb.agent` for custom tasks the built-in actions do not cover.
- `filters` for simple base/head branch, actor, label, draft, or changed-path matches; use `conditionGroups` for AND/OR combinations.
- `actionParameters` for `reviewPrompt`, `agentPrompt`, `bodyTemplate`, `targetBranch`, and `label` when needed. Templates support `{{review}}`, `{{agent}}`, `{{repo}}`, `{{owner}}`, `{{name}}`, `{{prNumber}}`, `{{issueNumber}}`, `{{number}}` (either issue or PR), `{{title}}`, `{{event}}`, `{{base}}`, `{{head}}`, `{{actor}}`, and `{{sha}}`.

Issue triggers support `bb.agent`, `github.comment`, `github.label`, and `checkout.update`. Put `bb.review` and `github.review` in separate PR rules. Issue events have no branches or changed files, so avoid base/head/path filters for issue-only rules. The actor is the issue author, not the person who made a change. `issue.edited` observes title or description changes, not new comments. Label/assignee triggers compare states between polls. Polling reads the 100 most recently updated open issues and 50 most recently updated closed issues; it can miss changes outside that window or changes undone between polls. Existing issues are baselined without replay on first use or after re-enabling a repository.

For `bb.agent`, require a nonblank `agentPrompt` describing the user's action. It starts an agent using the repository project's defaults (or the configured default project), in a managed worktree with `accept-edits` permissions. It works with issue and PR events and `push.base`. Issue actions receive the issue number, labels, assignees, observed changes, and instructions to read the full issue with `gh issue view`. Write instructions for the actual task, including any requested GitHub writes; creating a rule does not perform the task immediately. Event fields are supplied separately as untrusted data; `agentPrompt` is literal text, not a body template. The worktree starts from the project's default branch, so tell the agent to inspect or check out the event's PR or SHA when needed. The agent's response is available to a later comment or review action as `{{agent}}`. Approval, dry run, the 30-minute agent wait limit, and job retries apply. Explain that retries can repeat incomplete agent work, so mutation tasks should check current state before making changes.

Keep the tool defaults, disabled and approval-required, unless the user explicitly asks to enable the rule or remove approval. Never invent events or actions outside the lists above.

Ask a focused clarification when the trigger or action is genuinely missing. If the tool reports that the repository is not tracked, tell the user to open GitHub+ and attach the project or add the repository, then try again. If it reports that automation is off for the repository, tell the user to enable it in GitHub+ Settings → Advanced automation settings → Repository automation.

Summarize the saved draft as Repository → When → Conditions → Action → Approval, then direct the user to **Automations** to review and enable it. Detailed controls are under **Advanced**; polling and quota are in Settings.

## Show the result card

After a successful rule creation, end the response with one directive on its own line. Use the exact repository name from the tool result:

```md
::github-automation{status="success" title="Rule created" repository="owner/repo" page="rules"}
```

Do not emit the directive after a failed tool call or when the repository name is unavailable. Keep it out of code fences and inline code.
