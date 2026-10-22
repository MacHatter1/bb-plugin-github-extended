import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  experimental_Icon as Icon,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { DependabotAlert, githubRpcContract } from "./server.js";
import type { Item, RepoStatus, Route } from "./app-logic.js";
import { AskAgent } from "./agent-task.js";
import {
  EventsPage,
  ToneBadge,
  relativeTime,
  useDashboard,
} from "./automation-view.js";
import { Button, Input, Skeleton } from "./shared-ui.js";
import { PageHeading, QuietEmpty } from "./surface-ui.js";
import { PaginationControls, usePagination } from "./pagination.js";
import { ItemStateIcon, PullRequestStatus } from "./item-status.js";
import { GithubLabel } from "./github-label.js";

type InboxType = "all" | "issues" | "pulls" | "security" | "approvals";
const TYPE_LABELS: Record<InboxType, string> = {
  all: "All types",
  issues: "Issues",
  pulls: "Pull requests",
  security: "Security",
  approvals: "Approvals",
};

export function InboxView({
  repo,
  repos,
  navigate,
}: {
  repo: string;
  repos: RepoStatus[];
  navigate: (route: Route) => void;
}) {
  const rpc = useRpc<typeof githubRpcContract>();
  const dashboard = useDashboard();
  const [items, setItems] = useState<Item[]>([]);
  const [alerts, setAlerts] = useState<DependabotAlert[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [type, setType] = useState<InboxType>("all");
  const [attention, setAttention] = useState(true);
  const [search, setSearch] = useState("");
  const request = useRef(0);
  const load = useCallback(async () => {
    const id = ++request.current;
    setLoading(true);
    const results = await Promise.allSettled([
      rpc.call("listItems", { kind: "issue" }),
      rpc.call("listItems", { kind: "pr" }),
      rpc.call("listDependabotAlerts", repo ? { repos: [repo] } : {}),
    ]);
    if (id !== request.current) return;
    const [issues, pulls, security] = results;
    setItems((current) => [
      ...(issues.status === "fulfilled"
        ? issues.value.items
        : current.filter((item) => item.kind === "issue")),
      ...(pulls.status === "fulfilled"
        ? pulls.value.items
        : current.filter((item) => item.kind === "pr")),
    ]);
    if (security.status === "fulfilled") setAlerts(security.value.alerts);
    const problems = results.flatMap((result, index) =>
      result.status === "rejected"
        ? [
            `${["Issues", "Pull requests", "Security alerts"][index]} could not load. Retry to refresh this part of the inbox.`,
          ]
        : [],
    );
    if (security.status === "fulfilled")
      problems.push(
        ...security.value.errors.map(
          (error) =>
            `Security alerts unavailable for ${error.repo}. Check repository access and alert settings on GitHub.`,
        ),
      );
    setErrors(problems);
    setLoading(false);
  }, [rpc, repo]);
  useEffect(() => {
    void load();
    return () => {
      request.current++;
    };
  }, [load]);
  useRealtime("data-changed", () => {
    void load();
  });
  const matches = (text: string) =>
    text.toLowerCase().includes(search.trim().toLowerCase());
  const scopedItems = useMemo(
    () =>
      items
        .filter(
          (item) =>
            (!repo || item.repo === repo) &&
            (!attention ||
              ["OPEN", "DRAFT"].includes(item.state.toUpperCase())) &&
            matches(
              `${item.repo} #${item.number} ${item.title} ${item.author} ${item.labels.join(" ")}`,
            ),
        )
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [items, repo, attention, search],
  );
  const scopedAlerts = alerts.filter(
    (alert) =>
      (!repo || alert.repo === repo) &&
      (!attention ||
        (alert.state.toLowerCase() === "open" &&
          ["critical", "high"].includes(alert.severity.toLowerCase()))) &&
      matches(
        `${alert.repo} #${alert.number} ${alert.packageName} ${alert.summary}`,
      ),
  );
  const approvals = (dashboard.data?.jobs ?? []).filter(
    (job) =>
      job.status === "pending_approval" &&
      (!repo || job.repo === repo) &&
      matches(`${job.repo} ${job.title} ${job.id}`),
  );
  const visibleItems = scopedItems.filter(
    (item) =>
      type === "all" ||
      (type === "issues" && item.kind === "issue") ||
      (type === "pulls" && item.kind === "pr"),
  );
  const visibleAlerts =
    type === "all" || type === "security" ? scopedAlerts : [];
  const paginationKey = JSON.stringify([repo, type, attention, search.trim().toLowerCase()]);
  const alertPages = usePagination(visibleAlerts.length, paginationKey);
  const itemPages = usePagination(visibleItems.length, paginationKey);
  const itemLabel = type === "issues" ? "Issues" : type === "pulls" ? "Pull requests" : "Issues and pull requests";
  const showApprovals = type === "all" || type === "approvals";
  const total =
    visibleItems.length +
    visibleAlerts.length +
    (showApprovals ? approvals.length : 0);
  const counts: Record<InboxType, number> = {
    all: scopedItems.length + scopedAlerts.length + approvals.length,
    issues: scopedItems.filter((item) => item.kind === "issue").length,
    pulls: scopedItems.filter((item) => item.kind === "pr").length,
    security: scopedAlerts.length,
    approvals: approvals.length,
  };
  const typeIcons: Record<InboxType, string> = {
    all: "Layers",
    issues: "Circle",
    pulls: "GitPullRequest",
    security: "SecurityCheck",
    approvals: "CircleCheck",
  };
  return (
    <div className="gh-stack">
      <PageHeading
        title="Inbox"
        description={
          attention
            ? "The work that needs a look, across your repositories."
            : "Browse issues, pull requests, and security alerts in one place."
        }
        detail={
          !loading && !dashboard.loading ? (
            <span className="gh-count">{total}</span>
          ) : undefined
        }
        action={
          <Button
            size="sm"
            disabled={repos.length === 0}
            onClick={() => navigate({ view: "new" })}
          >
            <Icon name="Plus" aria-hidden="true" />
            New issue
          </Button>
        }
      />
      <div className="gh-inbox-controls">
        <div className="gh-filter-bar">
          <div className="gh-segment" role="group" aria-label="Inbox view">
            <Button
              size="sm"
              variant={attention ? "secondary" : "ghost"}
              aria-pressed={attention}
              onClick={() => setAttention(true)}
            >
              Needs attention
            </Button>
            <Button
              size="sm"
              variant={!attention ? "secondary" : "ghost"}
              aria-pressed={!attention}
              onClick={() => setAttention(false)}
            >
              Everything
            </Button>
          </div>
          <div className="gh-search">
            <Icon name="Search" aria-hidden="true" />
            <Input
              aria-label="Search inbox"
              placeholder="Search inbox…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
        </div>
        <div className="gh-type-filters" role="group" aria-label="Inbox type">
          {(Object.keys(TYPE_LABELS) as InboxType[]).map((value) => (
            <Button
              key={value}
              size="sm"
              variant="ghost"
              aria-label={TYPE_LABELS[value]}
              aria-description={`${counts[value]} items`}
              aria-pressed={type === value}
              onClick={() => setType(value)}
            >
              <Icon name={typeIcons[value]} aria-hidden="true" />
              {TYPE_LABELS[value]}
              <span className="gh-count" aria-hidden="true">
                {counts[value]}
              </span>
            </Button>
          ))}
        </div>
      </div>
      {errors.length > 0 || dashboard.error ? (
        <div role="alert" className="gh-alert">
          <Icon name="AlertCircle" aria-hidden="true" />
          <div>
            {errors.map((message) => (
              <p key={message}>{message}</p>
            ))}
            {dashboard.error ? (
              <p>Approvals could not load. Retry to refresh them.</p>
            ) : null}
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              void load();
              void dashboard.refetch();
            }}
          >
            Retry inbox
          </Button>
        </div>
      ) : null}
      {loading || dashboard.loading ? (
        <div role="status" aria-label="Loading inbox">
          <Skeleton className="h-14 w-full" />
        </div>
      ) : null}
      {showApprovals && approvals.length > 0 ? (
        <section aria-label="Pending approvals" className="gh-approval-queue">
          <EventsPage jobs={approvals} onChanged={dashboard.refetch} compact paginationKey={paginationKey} />
        </section>
      ) : null}
      {visibleAlerts.length > 0 ? (
        <details className="gh-group" data-pagination-region open>
          <summary>
            <Icon name="ChevronDown" aria-hidden="true" />
            Security alerts
            <span className="gh-count">{visibleAlerts.length}</span>
          </summary>
          <PaginationControls label="Security alerts" total={visibleAlerts.length} pagination={alertPages} />
          <ul className="gh-row-list">
            {visibleAlerts.slice(alertPages.offset, alertPages.end).map((alert) => (
              <li
                key={`security:${alert.repo}#${alert.number}`}
                className="gh-inbox-row"
              >
                <span className="gh-item-icon" data-kind="security">
                  <Icon name="SecurityCheck" aria-hidden="true" />
                </span>
                <div className="gh-item-content">
                  <button
                    className="gh-item-title"
                    title={alert.summary}
                    onClick={() =>
                      navigate({
                        view: "dependabot-alert",
                        repo: alert.repo,
                        number: alert.number,
                      })
                    }
                  >
                    {alert.summary}
                  </button>
                  <div className="gh-item-meta">
                    <ToneBadge
                      tone={
                        alert.severity.toLowerCase() === "critical"
                          ? "danger"
                          : alert.severity.toLowerCase() === "high"
                            ? "warning"
                            : "default"
                      }
                    >
                      {alert.severity}
                    </ToneBadge>
                    <span>{alert.packageName}</span>
                    <span className="gh-repo-name">{alert.repo}</span>
                    {alert.state !== "open" ? <span>{alert.state}</span> : null}
                  </div>
                </div>
                <div className="gh-item-actions">
                  <AskAgent
                    kind="security"
                    repo={alert.repo}
                    number={alert.number}
                  />
                  <time dateTime={alert.updatedAt}>
                    {relativeTime(alert.updatedAt)}
                  </time>
                </div>
              </li>
            ))}
          </ul>
          <PaginationControls label="Security alerts" total={visibleAlerts.length} pagination={alertPages} position="bottom" />
        </details>
      ) : null}
      {visibleItems.length > 0 ? (
        <details className="gh-group" data-pagination-region open>
          <summary>
            <Icon name="ChevronDown" aria-hidden="true" />
            {itemLabel}
            <span className="gh-count">{visibleItems.length}</span>
          </summary>
          <PaginationControls label={itemLabel} total={visibleItems.length} pagination={itemPages} />
          <ul className="gh-row-list">
            {visibleItems.slice(itemPages.offset, itemPages.end).map((item) => (
              <li
                key={`${item.kind}:${item.repo}#${item.number}`}
                className="gh-inbox-row"
              >
                <ItemStateIcon item={item} />
                <div className="gh-item-content">
                  <button
                    className="gh-item-title"
                    title={item.title}
                    onClick={() =>
                      navigate({
                        view: item.kind === "pr" ? "pull" : "issue",
                        repo: item.repo,
                        number: item.number,
                      })
                    }
                  >
                    {item.title}
                  </button>
                  <div className="gh-item-meta">
                    <span>
                      {item.kind === "pr" ? "Pull request" : "Issue"} #
                      {item.number}
                    </span>
                    <span className="gh-repo-name">{item.repo}</span>
                    <span>{item.state.toLowerCase()}</span>
                    {item.author ? <span>by {item.author}</span> : null}
                    {item.labels.slice(0, 2).map((label) => (
                      <GithubLabel key={label} name={label} color={item.labelColors?.[label]} />
                    ))}
                  </div>
                  {item.kind === "pr" ? (
                    <PullRequestStatus item={item} onOpen={() => navigate({ view: "pull", repo: item.repo, number: item.number })} />
                  ) : null}
                </div>
                <div className="gh-item-actions">
                  <AskAgent
                    kind={item.kind}
                    repo={item.repo}
                    number={item.number}
                  />
                  <time dateTime={item.updatedAt}>
                    {relativeTime(item.updatedAt)}
                  </time>
                </div>
              </li>
            ))}
          </ul>
          <PaginationControls label={itemLabel} total={visibleItems.length} pagination={itemPages} position="bottom" />
        </details>
      ) : null}
      {!loading && !dashboard.loading && total === 0 ? (
        <QuietEmpty
          icon={errors.length > 0 || dashboard.error ? "AlertCircle" : "Mail"}
          title={
            errors.length > 0 || dashboard.error
              ? "No items available in this view"
              : "You're all caught up"
          }
          description={
            search || repo
              ? "Try a different search or repository."
              : "Choose Everything to browse other states and lower-priority alerts."
          }
        />
      ) : null}
      <details className="gh-disclosure">
        <summary>
          <Icon name="SlidersHorizontal" aria-hidden="true" />
          Advanced search and saved views
        </summary>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => navigate({ view: "issues" })}
          >
            Search issues
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => navigate({ view: "pulls" })}
          >
            Search pull requests
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => navigate({ view: "dependabot" })}
          >
            Search security alerts
          </Button>
        </div>
      </details>
    </div>
  );
}
