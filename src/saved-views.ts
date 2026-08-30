export type SavedViewTab = "issues" | "pulls" | "dependabot";

export interface SavedView {
  name: string;
  query: string;
}

export type SavedViews = Record<SavedViewTab, SavedView[]>;

export const SAVED_VIEWS_KEY = "bb-plugin-github-extended:saved-views";

export const QUERY_STATE_KEY = "bb-plugin-github-extended:queries";
export const LEGACY_QUERY_KEY = "bb-plugin-github-extended:query";
export const DEFAULT_QUERY = "is:open ";

export type QueryState = Record<SavedViewTab, string>;

const emptyQueryState = (): QueryState => ({
  issues: DEFAULT_QUERY,
  pulls: DEFAULT_QUERY,
  dependabot: DEFAULT_QUERY,
});

export function loadQueryState(
  storage: Pick<Storage, "getItem">,
): QueryState {
  const result = emptyQueryState();
  try {
    const raw = storage.getItem(QUERY_STATE_KEY);
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      for (const tab of ["issues", "pulls", "dependabot"] as const) {
        const value = (parsed as Record<string, unknown>)[tab];
        if (typeof value === "string") result[tab] = value;
      }
      return result;
    }
    const legacy = storage.getItem(LEGACY_QUERY_KEY);
    if (legacy !== null) result.issues = legacy;
  } catch {
    try {
      const legacy = storage.getItem(LEGACY_QUERY_KEY);
      if (legacy !== null) result.issues = legacy;
    } catch {
      // Browser storage can be unavailable or malformed.
    }
  }
  return result;
}

export function saveQueryState(
  storage: Pick<Storage, "setItem">,
  state: QueryState,
  activeTab?: SavedViewTab,
): void {
  try {
    storage.setItem(QUERY_STATE_KEY, JSON.stringify(state));
    if (activeTab !== undefined) {
      storage.setItem(LEGACY_QUERY_KEY, state[activeTab]);
    }
  } catch {
    // Browser storage can be unavailable or full; the query remains usable in memory.
  }
}

const emptySavedViews = (): SavedViews => ({
  issues: [],
  pulls: [],
  dependabot: [],
});

function isTab(value: string): value is SavedViewTab {
  return value === "issues" || value === "pulls" || value === "dependabot";
}

export function loadSavedViews(
  storage: Pick<Storage, "getItem">,
  key = SAVED_VIEWS_KEY,
): SavedViews {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(key) ?? "null");
    const result = emptySavedViews();
    if (typeof parsed !== "object" || parsed === null) return result;
    for (const tab of Object.keys(result)) {
      const entries = (parsed as Record<string, unknown>)[tab];
      if (!Array.isArray(entries)) continue;
      result[tab as SavedViewTab] = entries
        .filter(
          (entry): entry is { name: string; query: string } =>
            typeof entry === "object" &&
            entry !== null &&
            typeof (entry as { name?: unknown }).name === "string" &&
            typeof (entry as { query?: unknown }).query === "string" &&
            (entry as { name: string }).name.trim().length > 0,
        )
        .map((entry) => ({ name: entry.name.trim(), query: entry.query }))
        .slice(0, 50);
    }
    return result;
  } catch {
    return emptySavedViews();
  }
}

export function saveSavedViews(
  storage: Pick<Storage, "setItem">,
  views: SavedViews,
  key = SAVED_VIEWS_KEY,
): void {
  try {
    storage.setItem(key, JSON.stringify(views));
  } catch {
    // Browser storage can be unavailable or full; the view remains usable in memory.
  }
}

export function upsertSavedView(
  views: SavedViews,
  tab: SavedViewTab,
  name: string,
  query: string,
): SavedViews {
  if (!isTab(tab) || name.trim().length === 0) return views;
  const next = { ...views, [tab]: [...views[tab]] };
  const entry = { name: name.trim(), query };
  const index = next[tab].findIndex((view) => view.name === entry.name);
  if (index === -1) next[tab].push(entry);
  else next[tab][index] = entry;
  return next;
}

export function deleteSavedView(
  views: SavedViews,
  tab: SavedViewTab,
  name: string,
): SavedViews {
  return {
    ...views,
    [tab]: views[tab].filter((view) => view.name !== name),
  };
}
