import type { ReactNode } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { Button } from "./shared-ui.js";

export function WorkItemHeading({
  title,
  number,
  repo,
  onBack,
  backLabel = "Inbox",
  source,
  action,
  children,
}: {
  title: string;
  number: number;
  repo: string;
  onBack?: () => void;
  backLabel?: string;
  source: ReactNode;
  action: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="gh-detail-heading">
      <nav className="gh-detail-navigation" aria-label="Item navigation">
        {onBack ? (
          <Button size="sm" variant="ghost" className="gh-back" onClick={onBack}>
            <Icon name="ArrowLeft" aria-hidden="true" />
            {backLabel}
          </Button>
        ) : null}
        <span className="gh-detail-repo" title={repo}>{repo}</span>
        <span className="gh-detail-source">{source}</span>
      </nav>
      <div className="gh-detail-title">
        <h2>{title} <span>#{number}</span></h2>
        <div className="gh-detail-actions">{action}</div>
      </div>
      {children ? <div className="gh-detail-meta">{children}</div> : null}
    </header>
  );
}

export function PageHeading({
  title,
  description,
  action,
  detail,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  detail?: ReactNode;
}) {
  return (
    <header className="gh-page-heading">
      <div>
        <div className="gh-heading-line">
          <h2>{title}</h2>
          {detail}
        </div>
        <p>{description}</p>
      </div>
      {action ? <div className="gh-heading-action">{action}</div> : null}
    </header>
  );
}

export function QuietEmpty({
  icon,
  title,
  description,
}: {
  icon: string;
  title: string;
  description: string;
}) {
  return (
    <div className="gh-empty">
      <span className="gh-empty-icon">
        <Icon name={icon} aria-hidden="true" />
      </span>
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  );
}
