# Changelog

All notable changes to GitHub Extended are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## Unreleased

## 0.1.3 - 2026-10-20

### Added

- Approval-gated automation for issues, pull requests, reviews, CI, and
  base-branch changes, with dry run, durable jobs, replay, audit, and quota controls.
- Custom actions described through Something else?, plus rule creation from chat.
- Inbox, Automations, and Activity views with shared repository scope.
- Native task composition and linked conversations for issues, PRs, and alerts.
- Shared list pagination and complete repository-scoped Activity history.
- Repository branding, fictional-data screenshots, store overview, and detailed guides.

### Changed

- Require Plugin SDK 0.6.49 or newer.
- Keep advanced rule and search controls behind disclosures.
- Load repository counts together and explain unavailable security alerts.

### Fixed

- Preserve draft and JSON edits across saves, realtime updates, and refresh failures.
- Persist saved-rule switches immediately while retaining other draft edits.
- Keep older approvals and scoped history reachable after newer jobs accumulate.
- Resolve host IDs when starting isolated review work.

## 0.1.2 - 2026-08-31

### Changed

- Reduce background synchronisation noise.

## 0.1.1 - 2026-08-30

### Fixed

- Include the production dependency required by installed plugins.

## 0.1.0 - 2026-08-30

### Added

- Discover and track repositories from BB projects or extra repository settings.
- Browse GitHub issues, pull requests, and Dependabot alerts from a local cache.
- Read discussions and diffs, edit GitHub items, and link agent work to them.
- Search, saved views, composer mentions, and CLI commands for cached GitHub work.
