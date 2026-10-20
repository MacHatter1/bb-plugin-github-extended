# Troubleshooting

[Back to the README](../README.md)

## GitHub CLI is unavailable or unauthenticated

Run:

```sh
gh auth status --hostname github.com
bb plugin reload github-extended
```

If `gh` is not installed, install it from [cli.github.com](https://cli.github.com/)
and run `gh auth login`.

## A repository is missing

Check that its local BB project source has a GitHub `origin` remote, or add the
repository explicitly through `Extra repositories`. Then run:

```sh
bb github-extended sync
```

## Dependabot shows a permission or disabled-alert error

Dependabot alerts are controlled by GitHub per repository. Enable Dependabot
alerts where appropriate. If the error reports a missing `security_events`
scope, run `gh auth refresh -h github.com -s security_events`, then reload or
synchronise the plugin after changing access.

## Inspect plugin logs

```sh
bb plugin logs github-extended -n 50
```

GitHub content is treated as untrusted input. Review agent changes in BB before
accepting them, and confirm the target project before starting agent work.
