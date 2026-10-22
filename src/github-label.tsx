import { githubLabelStyle } from "./github-labels.js";

export function GithubLabel({ name, color }: { name: string; color?: string }) {
  return <span className="gh-label" style={githubLabelStyle(color)} title={name}>{name}</span>;
}
