---
name: github-automation
description: Create GitHub+ automation rules from natural-language requests. Use when the user asks to automate pull-request, CI, review, or base-branch actions for a tracked GitHub repository.
---

# GitHub+ automation rules

Use `github_extended_create_rule` to create one rule. When `repo` is omitted, the tool scopes the rule to the GitHub repository attached to the current BB project.

Translate the request into:

- `events`: one or more of `pr.opened`, `pr.synchronised`, `pr.review_requested`, `pr.approved`, `pr.changes_requested`, `ci.success`, `ci.failure`, `pr.merged`, `pr.closed`, or `push.base`.
- `actions`: ordered supported actions: `bb.review`, `github.comment`, `github.review`, `github.label`, or `checkout.update`.
- `filters` for simple base/head branch, actor, label, draft, or changed-path matches; use `conditionGroups` for AND/OR combinations.
- `actionParameters` for `reviewPrompt`, `bodyTemplate`, `targetBranch`, and `label` when needed. Templates support `{{review}}`, `{{repo}}`, `{{owner}}`, `{{name}}`, `{{prNumber}}`, `{{title}}`, `{{event}}`, `{{base}}`, `{{head}}`, `{{actor}}`, and `{{sha}}`.

Keep the tool defaults, disabled and approval-required, unless the user explicitly asks to enable the rule or remove approval. Never invent events or actions outside the lists above.

Ask a focused clarification when the trigger or action is genuinely missing. If the tool reports that the repository is not tracked, tell the user to open GitHub+ and attach the project or add the repository, then try again. If it reports that automation is off for the repository, tell the user to enable it on the GitHub+ Automation page.

## Show the result card

After a successful rule creation, end the response with one directive on its own line. Use the exact repository name from the tool result:

```md
::github-automation{status="success" title="Rule created" repository="owner/repo" page="rules"}
```

Do not emit the directive after a failed tool call or when the repository name is unavailable. Keep it out of code fences and inline code.
