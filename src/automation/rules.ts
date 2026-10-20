// Ordered rule matching: enabled rules whose trigger, repository, flat
// filters, and every condition group accept the event, sorted by order.
import type { AutomationRule, NormalisedEvent, RuleCondition } from "./domain.js";

export function wildcard(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`, "i").test(value);
}

function values(condition: RuleCondition, event: NormalisedEvent): string[] {
  switch (condition.field) {
    case "base":
      return [event.base];
    case "head":
      return [event.head];
    case "actor":
      return [event.actor];
    case "label":
      return event.labels;
    case "draft":
      return [String(event.draft)];
    case "path":
      return event.files;
    case "event":
      return [event.kind];
    case "repository":
      return [event.repo];
  }
}

function matchCondition(condition: RuleCondition, event: NormalisedEvent): boolean {
  const actual = values(condition, event);
  const wanted = condition.value.toLowerCase();
  const positive =
    condition.operator === "matches"
      ? actual.some((value) => wildcard(condition.value, value))
      : condition.operator === "contains"
        ? actual.some((value) => value.toLowerCase().includes(wanted))
        : actual.some((value) => value.toLowerCase() === wanted);
  return condition.operator === "not_equals" ? !positive : positive;
}

export function matchesRule(rule: AutomationRule, event: NormalisedEvent): boolean {
  if (!rule.enabled || !rule.events.includes(event.kind)) return false;
  if (
    rule.repos.length > 0 &&
    !rule.repos.some((repo) => repo.toLowerCase() === event.repo.toLowerCase())
  ) {
    return false;
  }
  const filters = rule.filters ?? {};
  if (
    (filters.base !== undefined && !wildcard(filters.base, event.base)) ||
    (filters.head !== undefined && !wildcard(filters.head, event.head)) ||
    (filters.actor !== undefined && !wildcard(filters.actor, event.actor))
  ) {
    return false;
  }
  if (filters.draft !== undefined && filters.draft !== event.draft) return false;
  if (
    filters.labels !== undefined &&
    filters.labels.length > 0 &&
    !filters.labels.every((label) => event.labels.includes(label))
  ) {
    return false;
  }
  if (
    filters.paths !== undefined &&
    filters.paths.length > 0 &&
    !event.files.some((file) => filters.paths!.some((path) => wildcard(path, file)))
  ) {
    return false;
  }
  return (rule.conditionGroups ?? []).every(
    (group) =>
      group.conditions.length === 0 ||
      (group.combinator === "and"
        ? group.conditions.every((condition) => matchCondition(condition, event))
        : group.conditions.some((condition) => matchCondition(condition, event))),
  );
}

export function matchingRules(rules: AutomationRule[], event: NormalisedEvent): AutomationRule[] {
  return rules
    .filter((rule) => matchesRule(rule, event))
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

/** True when any enabled rule needs the changed-file list to match. */
export function rulesUsePaths(rules: AutomationRule[]): boolean {
  return rules.some(
    (rule) =>
      rule.enabled &&
      ((rule.filters?.paths?.length ?? 0) > 0 ||
        (rule.conditionGroups ?? []).some((group) =>
          group.conditions.some((condition) => condition.field === "path"),
        )),
  );
}
