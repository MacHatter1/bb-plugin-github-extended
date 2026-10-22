import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { Item } from "./app-logic.js";
import { pullCheckSummary } from "./pull-status.js";
import { ToneBadge } from "./automation-view.js";

export function ItemStateIcon({ item }: { item: Pick<Item, "kind" | "state"> }) {
  const state = item.state.toUpperCase();
  const name = item.kind === "issue" ? state === "OPEN" ? "Circle" : "CircleCheck"
    : state === "MERGED" ? "GitMerge" : state === "CLOSED" ? "GitPullRequestClosed"
      : state === "DRAFT" ? "GitPullRequestDraft" : "GitPullRequest";
  const label = `${state.toLowerCase()} ${item.kind === "pr" ? "pull request" : "issue"}`;
  return (
    <span className="gh-item-icon" data-kind={item.kind} data-state={state} role="img" aria-label={label} title={label}>
      <Icon name={name} aria-hidden="true" />
    </span>
  );
}

export function PullRequestStatus({ item, onOpen }: { item: Item; onOpen: () => void }) {
  const pull = item.pullRequest;
  const ci = pullCheckSummary(pull?.checks);
  const review = pull?.reviewDecision;
  const details = pull?.checks?.map((check) => `${check.name}: ${check.status}`).join("\n");
  return (
    <div className="gh-pr-summary" aria-label={`Pull request #${item.number} status`}>
      <button type="button" className="gh-status-button" onClick={onOpen}
        aria-label={`Checks for pull request #${item.number}: ${ci.label}`}
        title={details || (ci.status === "unknown" ? "Checks have not been synced yet. Refresh the repository to load them." : "No checks reported for this pull request.")}>
        <ToneBadge tone={ci.status === "failure" ? "danger" : ci.status === "pending" ? "warning" : ci.status === "success" ? "success" : "default"}>
          <Icon name={ci.status === "failure" ? "CircleX" : ci.status === "pending" ? "Clock" : ci.status === "success" ? "CircleCheck" : "Minus"} aria-hidden="true" />
          {ci.label}
        </ToneBadge>
      </button>
      {review === "APPROVED" ? <ToneBadge tone="success">Approved</ToneBadge>
        : review === "CHANGES_REQUESTED" ? <ToneBadge tone="danger">Changes requested</ToneBadge>
          : review === "REVIEW_REQUIRED" ? <ToneBadge>Review required</ToneBadge> : null}
      {pull?.mergeStateStatus === "DIRTY" ? <ToneBadge tone="danger">Merge conflicts</ToneBadge> : null}
      {pull?.headRefName && pull.baseRefName ? (
        <span className="gh-pr-branches" title={`${pull.headRefName} → ${pull.baseRefName}`}>
          <Icon name="GitBranch" aria-hidden="true" />
          {pull.headRefName} → {pull.baseRefName}
        </span>
      ) : null}
      {pull && pull.additions + pull.deletions > 0 ? (
        <span className="gh-pr-diff" aria-label={`${pull.additions} additions, ${pull.deletions} deletions`}>
          <span>+{pull.additions}</span> <span>−{pull.deletions}</span>
        </span>
      ) : null}
    </div>
  );
}
