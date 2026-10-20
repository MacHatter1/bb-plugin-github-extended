// @vitest-environment jsdom

import { afterEach, describe, expect, it, beforeEach, vi } from "vitest";
import { act, createElement } from "react";
import { cleanup, fireEvent } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

afterEach(() => { cleanup(); window.localStorage.clear(); });

const app = await loadPluginApp(() => import("./app"));

describe("GitHub app navigation", () => {
  it("labels the extended GitHub surfaces distinctly", () => {
    expect(app.navPanels[0]?.title).toBe("GitHub+");
    expect(app.threadPanelActions[0]?.title).toBe("GitHub+ PR");
  });

  it("keeps legacy security routes inside Inbox", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "dependabot" },
      {
        rpc: {
          status: () => ({
            ghOk: true,
            ghState: "ready",
            ghError: null,
            repos: [],
            lastSyncedAt: null,
          }),
          viewer: () => ({ login: "octocat" }),
          listDependabotAlerts: () => ({
            alerts: [],
            errors: [],
            stats: { totalCount: 0, highCriticalCount: 0, withFixCount: 0, withoutFixCount: 0 },
          }),
        },
      },
    ) as any;

    await act(async () => {});
    const dependabotTab = slot.getByRole("tab", { name: "Inbox" });
    const panelId = dependabotTab.getAttribute("aria-controls");
    expect(panelId).toBeTruthy();
    expect(slot.container.querySelector("#" + panelId)?.getAttribute("role")).toBe("tabpanel");
    expect(slot.container.querySelector("#" + panelId)?.getAttribute("aria-labelledby")).toBe(dependabotTab.id);
    await dependabotTab.click();
    expect(slot.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "github",
      options: { subPath: "" },
    });
    slot.lifecycle.unmount();
  });

  it("keeps disabled Dependabot alerts separate from missing permissions", async () => {
    const message = [
      "gh api --paginate --jq failed: gh: Dependabot alerts are disabled for this repository. (HTTP 403)",
      'gh: This API operation needs the "delete_repo" scope. To request it, run:',
      "gh auth refresh -h github.com -s delete_repo",
    ].join("\n");
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "dependabot" },
      {
        rpc: {
          listItems: () => ({ items: [] }),
          status: () => ({
            ghOk: true,
            ghState: "ready",
            ghError: null,
            repos: [{
              repo: "acme/widgets",
              projectId: null,
              health: {
                status: "error",
                lastAttemptAt: null,
                lastSuccessAt: null,
                itemCount: 0,
                alertCount: 0,
                error: "Dependabot: " + message,
              },
            }],
            lastSyncedAt: null,
          }),
          viewer: () => ({ login: "octocat" }),
          listDependabotAlerts: () => ({
            alerts: [],
            errors: [{ repo: "acme/widgets", message }],
            stats: { totalCount: 0, highCriticalCount: 0, withFixCount: 0, withoutFixCount: 0 },
          }),
        },
      },
    ) as any;

    await act(async () => {});
    await slot.getByRole("button", { name: "Settings" }).click();
    const notices = Array.from(
      slot.container.querySelectorAll(".github-alert-error") as NodeListOf<HTMLElement>,
    );
    expect(notices.length).toBeGreaterThan(0);
    for (const notice of notices) {
      expect(notice.textContent).toMatch(/Enable (?:alerts|them) in GitHub/);

      expect(notice.textContent).not.toContain("delete_repo");
      expect(notice.querySelector("code")).toBeNull();
      expect(notice.querySelector("details")).toBeNull();
    }
    slot.lifecycle.unmount();
  });

  it("opens issue details in the URL-backed page instead of a fixed tab", async () => {
    const panel = app.navPanels[0]!;
    expect(panel.fixedTabs).toBeUndefined();

    const slot = renderSlot(
      panel,
      { subPath: "issues" },
      {
        rpc: {
          listItems: () => ({
            items: [
              {
                repo: "get-bb/bb",
                number: 42,
                kind: "issue",
                title: "Route-backed issue",
                state: "OPEN",
                author: "octocat",
                labels: [],
                assignees: [],
                url: "https://github.com/get-bb/bb/issues/42",
                body: "",
                updatedAt: "2026-08-20T00:00:00.000Z",
              },
            ],
          }),
          listLinks: () => ({ links: {} }),
          status: () => ({
            ghOk: true,
            ghState: "ready",
            ghError: null,
            repos: [{ repo: "get-bb/bb", projectId: null, health: { status: "never", lastAttemptAt: null, lastSuccessAt: null, itemCount: 0, alertCount: 0, error: null } }],
            lastSyncedAt: null,
          }),
          viewer: () => ({ login: "octocat" }),
        },
      },
    ) as any;

    (await slot.findByText("Route-backed issue")).click();
    expect(slot.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "github",
      options: { subPath: "issues/get-bb/bb/42" },
    });
    slot.lifecycle.unmount();
  });

  it("uses the standard responsive page inset for the main panel", () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: {
          listItems: () => ({ items: [] }),
          status: () => ({
            ghOk: true,
            ghState: "ready",
            ghError: null,
            repos: [],
            lastSyncedAt: null,
          }),
          viewer: () => ({ login: "octocat" }),
        },
      },
    ) as any;

    expect(slot.container.firstElementChild?.className).toContain("p-4 md:p-5");
    expect(slot.container.firstElementChild?.className).not.toContain("p-3");
    slot.lifecycle.unmount();
  });

  it("keeps repository management collapsed until opened", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "issues" },
      {
        rpc: {
          listItems: () => ({ items: [] }),
          listLinks: () => ({ links: {} }),
          status: () => ({
            ghOk: true,
            ghState: "ready",
            ghError: null,
            repos: [{
              repo: "acme/widgets",
              projectId: null,
              health: {
                status: "ok",
                lastAttemptAt: null,
                lastSuccessAt: null,
                itemCount: 1,
                alertCount: 0,
                error: null,
              },
            }],
            lastSyncedAt: "2026-08-20T00:00:00.000Z",
          }),
          viewer: () => ({ login: "octocat" }),
        },
      },
    ) as any;

    await act(async () => {});
    expect(slot.queryByPlaceholderText("Add owner/repository or GitHub URL")).toBeNull();
    const reposToggle = slot.container.querySelector(
      'button[aria-controls="github-repos-drawer"]',
    ) as HTMLButtonElement;
    expect(reposToggle.getAttribute("aria-expanded")).toBe("false");
    await reposToggle.click();
    expect(reposToggle.getAttribute("aria-expanded")).toBe("true");
    expect(slot.getByPlaceholderText("Add owner/repository or GitHub URL")).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("loads repository count badges through one batched summary RPC", async () => {
    const listItems = vi.fn(() => ({ items: [] }));
    const listDependabotAlerts = vi.fn(() => ({
      alerts: [],
      errors: [],
      stats: { totalCount: 0, highCriticalCount: 0, withFixCount: 0, withoutFixCount: 0 },
    }));
    const listRepositorySummaries = vi.fn(() => ({
      repos: [{
        repo: "acme/widgets",
        issueCount: 4,
        pullRequestCount: 2,
        alertCount: 3,
      }],
    }));
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "issues" },
      {
        rpc: {
          listItems,
          listLinks: () => ({ links: {} }),
          listDependabotAlerts,
          listRepositorySummaries,
          status: () => ({
            ghOk: true,
            ghState: "ready",
            ghError: null,
            repos: [{
              repo: "acme/widgets",
              projectId: null,
              health: {
                status: "ok",
                lastAttemptAt: null,
                lastSuccessAt: null,
                itemCount: 1,
                alertCount: 0,
                error: null,
              },
            }],
            lastSyncedAt: "2026-08-20T00:00:00.000Z",
          }),
          viewer: () => ({ login: "octocat" }),
        },
      },
    ) as any;

    await act(async () => {});
    expect(listRepositorySummaries).not.toHaveBeenCalled();
    const itemCallsBeforeOpening = listItems.mock.calls.length;
    const reposToggle = slot.container.querySelector(
      'button[aria-controls="github-repos-drawer"]',
    ) as HTMLButtonElement;
    await reposToggle.click();

    await vi.waitFor(() => {
      expect(listRepositorySummaries).toHaveBeenCalledTimes(1);
      const drawer = slot.container.querySelector("#github-repos-drawer");
      expect(drawer).toBeTruthy();
      const badges = Array.from(
        drawer!.querySelectorAll("span") as NodeListOf<HTMLSpanElement>,
      )
        .filter((element: HTMLSpanElement) =>
          ["Issues", "PRs", "Alerts"].includes(element.textContent ?? ""),
        )
        .map((label: HTMLSpanElement) => [
          label.textContent,
          label.previousElementSibling?.textContent,
        ]);
      expect(badges).toEqual([["Issues", "4"], ["PRs", "2"], ["Alerts", "3"]]);
    });
    expect(listItems).toHaveBeenCalledTimes(itemCallsBeforeOpening);
    expect(listDependabotAlerts).not.toHaveBeenCalled();
    slot.lifecycle.unmount();
  });

  it("exposes filter suggestions as a combobox without trapping Tab", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "issues" },
      {
        rpc: {
          status: () => ({
            ghOk: true,
            ghState: "ready",
            ghError: null,
            repos: [],
            lastSyncedAt: null,
          }),
          listItems: () => ({
            items: [{
              repo: "acme/widgets",
              number: 7,
              kind: "issue",
              title: "Filter semantics",
              state: "OPEN",
              author: "octocat",
              labels: [],
              assignees: [],
              url: "https://github.com/acme/widgets/issues/7",
              body: "",
              updatedAt: "2026-08-20T00:00:00.000Z",
            }],
          }),
          listLinks: () => ({ links: {} }),
          viewer: () => ({ login: "octocat" }),
        },
      },
    ) as any;

    await act(async () => {});
    const input = slot.container.querySelector('input[role="combobox"]');
    if (!(input instanceof HTMLInputElement)) throw new Error("filter input was not rendered");
    fireEvent.change(input, { target: { value: "is" } });
    expect(input.getAttribute("aria-expanded")).toBe("true");
    const listboxId = input.getAttribute("aria-controls");
    expect(listboxId).toBeTruthy();
    expect(slot.getByRole("listbox").id).toBe(listboxId);

    const tab = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
    slot.lifecycle.unmount();
  });

  it("keeps the repository picker closed until opened", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "new" },
      {
        rpc: {
          status: () => ({
            ghOk: true,
            ghState: "ready",
            ghError: null,
            repos: [
              { repo: "get-bb/bb", projectId: null, health: { status: "ok", lastAttemptAt: null, lastSuccessAt: null, itemCount: 1, alertCount: 0, error: null } },
              { repo: "acme/widgets", projectId: null, health: { status: "ok", lastAttemptAt: null, lastSuccessAt: null, itemCount: 1, alertCount: 0, error: null } },
            ],
            lastSyncedAt: null,
          }),
        },
      },
    ) as any;

    await act(async () => {});
    expect(slot.queryByRole("button", { name: "acme/widgets", exact: true })).toBeNull();
    await (slot.container.querySelector("#github-new-issue-repo") as HTMLButtonElement).click();
    const option = slot.getByRole("listbox").querySelector('[role="option"]:last-child') as HTMLButtonElement;
    expect(option.textContent).toBe("acme/widgets");
    await option.click();
    expect(slot.queryByRole("button", { name: "acme/widgets", exact: true })).toBeNull();
    slot.lifecycle.unmount();
  });

  it("supports listbox keyboard navigation and returns focus after selection", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "new" },
      {
        rpc: {
          status: () => ({
            ghOk: true,
            ghState: "ready",
            ghError: null,
            repos: [
              { repo: "get-bb/bb", projectId: null, health: { status: "ok", lastAttemptAt: null, lastSuccessAt: null, itemCount: 1, alertCount: 0, error: null } },
              { repo: "acme/widgets", projectId: null, health: { status: "ok", lastAttemptAt: null, lastSuccessAt: null, itemCount: 1, alertCount: 0, error: null } },
            ],
            lastSyncedAt: null,
          }),
        },
      },
    ) as any;

    await act(async () => {});
    const trigger = (slot.container.querySelector("#github-new-issue-repo") as HTMLButtonElement);
    trigger.focus();
    await act(async () => {
      trigger.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowDown",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(slot.getByRole("listbox")).toBeTruthy();
    expect(document.activeElement?.getAttribute("role")).toBe("option");

    const listbox = slot.getByRole("listbox");
    await act(async () => {
      listbox.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowDown",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(document.activeElement?.textContent).toContain("acme/widgets");

    await act(async () => {
      listbox.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(slot.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    slot.lifecycle.unmount();
  });

  it("keeps GitHub pull-request filenames out of live workspace navigation", async () => {
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thr-1", params: null },
      {
        rpc: {
          pullForThread: () => ({
            pull: {
              repo: "get-bb/bb",
              number: 42,
            },
          }),
          getPull: () => ({
            pull: {
              repo: "get-bb/bb",
              number: 42,
              title: "Navigation fix",
              state: "OPEN",
              author: "octocat",
              body: "",
              url: "https://github.com/get-bb/bb/pull/42",
              createdAt: "2026-08-20T00:00:00.000Z",
              updatedAt: "2026-08-20T00:00:00.000Z",
              baseRefName: "main",
              headRefName: "fix-navigation",
              additions: 1,
              deletions: 1,
              changedFiles: 2,
              labels: [],
              assignees: [],
              reviewDecision: "",
              mergeStateStatus: "CLEAN",
              reviewRequests: [],
              checks: [{ name: "build", status: "success", url: "" }],
              comments: [],
              reviews: [],
              reviewThreads: [],
              files: [
                {
                  path: "removed.ts",
                  status: "removed",
                  additions: 0,
                  deletions: 1,
                  patch: "@@ -1 +0,0 @@\n-removed",
                },
                {
                  path: "modified.ts",
                  status: "modified",
                  additions: 1,
                  deletions: 0,
                  patch: "@@ -0,0 +1 @@\n+added",
                },
                {
                  path: "../outside.ts",
                  status: "added",
                  additions: 1,
                  deletions: 0,
                  patch: null,
                },
              ],
            },
          }),
          listLinks: () => ({ links: {} }),
        },
      },
    ) as any;

    await act(async () => {});
    const checksToggle = slot.getByRole("button", { name: /Checks/ });
    expect(checksToggle.getAttribute("aria-expanded")).toBe("false");
    const checksId = checksToggle.getAttribute("aria-controls");
    expect(checksId).toBeTruthy();
    await checksToggle.click();
    expect(checksToggle.getAttribute("aria-expanded")).toBe("true");
    expect(slot.container.querySelector("#" + checksId)?.textContent).toContain("build");
    await slot.getByRole("button", { name: /Files changed/ }).click();
    const removedFile = slot.getByText("removed.ts");
    const modifiedFile = slot.getByText("modified.ts");
    const unsafeFile = slot.getByText("../outside.ts");
    expect(removedFile.closest("a")).toBeNull();
    expect(modifiedFile.closest("a")).toBeNull();
    expect(unsafeFile.closest("a")).toBeNull();

    const diffToggle = removedFile.parentElement?.querySelector("button");
    if (!(diffToggle instanceof HTMLButtonElement)) {
      throw new Error("removed file diff toggle was not rendered");
    }
    expect(diffToggle.getAttribute("aria-label")).toBe(
      "Expand removed.ts diff",
    );
    await act(async () => diffToggle.click());
    const diff = slot.getByTestId("bb-diff");
    expect(diff.getAttribute("data-path")).toBe("removed.ts");
    expect(diffToggle.getAttribute("aria-label")).toBe(
      "Collapse removed.ts diff",
    );
    slot.lifecycle.unmount();
  });

  it("keeps row actions from opening the parent item", async () => {
    const itemUrl = "https://github.com/get-bb/bb/issues/42";
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "issues" },
      {
        rpc: {
          listItems: () => ({
            items: [
              {
                repo: "get-bb/bb",
                number: 42,
                kind: "issue",
                title: "Menu isolation",
                state: "OPEN",
                author: "octocat",
                labels: [],
                assignees: [],
                url: itemUrl,
                body: "",
                updatedAt: "2026-08-20T00:00:00.000Z",
              },
            ],
          }),
          listLinks: () => ({ links: {} }),
          status: () => ({
            ghOk: true,
            ghState: "ready",
            ghError: null,
            repos: [],
            lastSyncedAt: null,
          }),
          viewer: () => ({ login: "octocat" }),
        },
      },
    ) as any;

    await act(async () => {});
    const menuTrigger = slot.getByRole("button", { name: "More actions for issue #42" });
    await menuTrigger.click();
    expect(slot.navigateCalls).toEqual([]);
    const menu = slot.getByRole("menu");
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    await act(async () => {
      menu.dispatchEvent(tab);
    });
    expect(tab.defaultPrevented).toBe(false);
    expect(slot.queryByRole("menu")).toBeNull();
    await menuTrigger.click();
    await slot.getByRole("menuitem", { name: "Open on GitHub ↗" }).click();
    await act(async () => {});
    expect(document.activeElement).toBe(menuTrigger);
    expect(slot.navigateCalls).toContainEqual({ method: "openUrl", url: itemUrl });
    expect(
      slot.navigateCalls.some((call: { method: string }) => call.method === "toPluginPanel"),
    ).toBe(false);
    slot.lifecycle.unmount();
  });

  it("renders unsafe detail URLs and Markdown images without active links or image loads", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "issues/acme/widgets/42" },
      {
        rpc: {
          status: () => ({
            ghOk: true,
            ghState: "ready",
            ghError: null,
            repos: [],
            lastSyncedAt: null,
          }),
          getIssue: () => ({
            issue: {
              repo: "acme/widgets",
              number: 42,
              title: "Safe rendering",
              state: "OPEN",
              author: "octocat",
              body: [
                "[unsafe](javascript:alert(1))",
                "![remote](https://example.com/remote.png)",
                '<img src="https://example.com/raw.png">',
                "| Name | Value |",
                "| --- | --- |",
                "| safe | data |",
              ].join("\n"),
              labels: [],
              assignees: [],
              url: "javascript:alert(1)",
              updatedAt: "2026-08-20T00:00:00.000Z",
              comments: [],
            },
          }),
          listLinks: () => ({
            links: {
              "issue:acme/widgets#42": [
                {
                  kind: "issue",
                  repo: "acme/widgets",
                  number: 42,
                  threadId: "thr-safe",
                  createdAt: "2026-08-20T00:00:00.000Z",
                },
              ],
            },
          }),
        },
      },
    ) as any;

    await act(async () => {});
    expect(slot.container.querySelector("a")).toBeNull();
    expect(slot.container.querySelector('img[src*="example.com"]')).toBeNull();
    expect(slot.container.querySelector("th")?.getAttribute("scope")).toBe("col");
    expect(slot.container.textContent).toContain("![remote](https://example.com/remote.png)");
    const threadPill = slot.getByRole("button", { name: "Open BB thread thr-safe" });
    expect(threadPill.tagName).toBe("BUTTON");
    threadPill.focus();
    await threadPill.click();
    expect(slot.navigateCalls).toContainEqual({ method: "toThread", threadId: "thr-safe" });
    slot.lifecycle.unmount();
  });

  it("surfaces status RPC failures with a retry action", async () => {
    let attempts = 0;
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "issues" },
      {
        rpc: {
          status: () => {
            attempts += 1;
            if (attempts === 1) return Promise.reject(new Error("status offline"));
            return {
              ghOk: true,
              ghState: "ready",
              ghError: null,
              repos: [],
              lastSyncedAt: null,
            };
          },
          listItems: () => ({ items: [] }),
          listLinks: () => ({ links: {} }),
          viewer: () => ({ login: "octocat" }),
        },
      },
    ) as any;

    await act(async () => {});
    const statusAlert = (): HTMLElement | undefined =>
      slot.queryAllByRole("alert").find((alert: HTMLElement) =>
        alert.textContent?.includes("status offline"),
      );
    expect(statusAlert()?.textContent).toContain("status offline");
    await slot.getByRole("button", { name: "Retry GitHub status" }).click();
    await act(async () => {});
    expect(statusAlert()).toBeUndefined();
    expect(attempts).toBe(2);
    slot.lifecycle.unmount();
  });

  it("ignores an older issue detail response after the route changes", async () => {
    const panel = app.navPanels[0]!;
    let resolveFirst: ((value: unknown) => void) | undefined;
    let resolveSecond: ((value: unknown) => void) | undefined;
    let detailCalls = 0;
    const makeIssue = (number: number, title: string) => ({
      repo: "acme/widgets",
      number,
      title,
      state: "OPEN",
      author: "octocat",
      body: "",
      labels: [],
      assignees: [],
      url: "https://github.com/acme/widgets/issues/" + number,
      updatedAt: "2026-08-20T00:00:00.000Z",
      comments: [],
    });
    const slot = renderSlot(
      panel,
      { subPath: "issues/acme/widgets/1" },
      {
        rpc: {
          status: () => ({
            ghOk: true,
            ghState: "ready",
            ghError: null,
            repos: [],
            lastSyncedAt: null,
          }),
          getIssue: () =>
            new Promise((resolve) => {
              detailCalls += 1;
              if (detailCalls === 1) resolveFirst = resolve;
              else resolveSecond = resolve;
            }),
          listLinks: () => ({ links: {} }),
        },
      },
    ) as any;

    await act(async () => {});
    expect(resolveFirst).toBeDefined();
    slot.lifecycle.rerender(
      createElement(panel.component as any, {
        subPath: "issues/acme/widgets/2",
      }),
    );
    await act(async () => {});
    expect(resolveSecond).toBeDefined();

    await act(async () => {
      resolveFirst?.({ issue: makeIssue(1, "Stale issue") });
    });
    expect(slot.queryByText("Stale issue")).toBeNull();

    await act(async () => {
      resolveSecond?.({ issue: makeIssue(2, "Current issue") });
    });
    expect(slot.getByText("Current issue")).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("ignores a late list response after switching between issues and pull requests", async () => {
    let resolveIssues: ((value: unknown) => void) | undefined;
    let resolvePulls: ((value: unknown) => void) | undefined;
    const makeItem = (kind: "issue" | "pr", number: number, title: string) => ({
      repo: "acme/widgets",
      number,
      kind,
      title,
      state: "OPEN",
      author: "octocat",
      labels: [],
      assignees: [],
      url: "https://github.com/acme/widgets/" + (kind === "pr" ? "pull" : "issues") + "/" + number,
      body: "",
      updatedAt: "2026-08-20T00:00:00.000Z",
    });
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "issues" },
      {
        rpc: {
          status: () => ({
            ghOk: true,
            ghState: "ready",
            ghError: null,
            repos: [],
            lastSyncedAt: null,
          }),
          listItems: (input: unknown) =>
            new Promise((resolve) => {
              const kind = (input as { kind?: "issue" | "pr" } | null)?.kind;
              if (kind === "pr") resolvePulls = resolve;
              else resolveIssues = resolve;
            }),
          listLinks: () => ({ links: {} }),
          viewer: () => ({ login: "octocat" }),
        },
      },
    ) as any;

    await act(async () => {});
    expect(resolveIssues).toBeDefined();
    slot.lifecycle.rerender(
      createElement(app.navPanels[0]!.component as any, { subPath: "pulls" }),
    );
    await act(async () => {});
    expect(resolvePulls).toBeDefined();

    await act(async () => {
      resolveIssues?.({ items: [makeItem("issue", 1, "Stale issue")] });
    });
    expect(slot.queryByText("Stale issue")).toBeNull();

    await act(async () => {
      resolvePulls?.({ items: [makeItem("pr", 2, "Current pull")] });
    });
    expect(slot.getByText("Current pull")).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("disables issue status changes until the mutation settles", async () => {
    let resolveState: ((value: unknown) => void) | undefined;
    const issue = {
      repo: "acme/widgets",
      number: 42,
      title: "Status ordering",
      state: "OPEN",
      author: "octocat",
      body: "",
      labels: [],
      assignees: [],
      url: "https://github.com/acme/widgets/issues/42",
      updatedAt: "2026-08-20T00:00:00.000Z",
      comments: [],
    };
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "issues/acme/widgets/42" },
      {
        rpc: {
          status: () => ({
            ghOk: true,
            ghState: "ready",
            ghError: null,
            repos: [],
            lastSyncedAt: null,
          }),
          getIssue: () => ({ issue }),
          listLinks: () => ({ links: {} }),
          viewer: () => ({ login: "octocat" }),
          setIssueState: () =>
            new Promise((resolve) => {
              resolveState = resolve;
            }),
        },
      },
    ) as any;

    await act(async () => {});
    const trigger = slot.getByRole("button", { name: "Issue status" });
    await trigger.click();
    await slot.getByRole("option", { name: "Closed" }).click();
    await act(async () => {});
    expect(slot.rpcCalls.find((call: { method: string }) => call.method === "setIssueState")).toEqual({
      method: "setIssueState",
      input: { repo: "acme/widgets", number: 42, state: "closed" },
    });
    expect(
      slot.rpcCalls.filter((call: { method: string }) => call.method === "setIssueState"),
    ).toHaveLength(1);
    expect(trigger.disabled).toBe(true);
    expect(trigger.getAttribute("aria-busy")).toBe("true");

    await act(async () => {
      resolveState?.({ ok: true });
    });
    expect(trigger.disabled).toBe(false);
    expect(trigger.getAttribute("aria-busy")).toBe("false");
    slot.lifecycle.unmount();
  });

  it("persists a thread PR choice through the app-side link RPC", async () => {
    let resolveLink: ((value: unknown) => void) | undefined;
    const pull = {
      repo: "acme/widgets",
      number: 42,
      title: "Linkable PR",
      state: "OPEN",
      author: "octocat",
      body: "",
      url: "https://github.com/acme/widgets/pull/42",
      createdAt: "2026-08-20T00:00:00.000Z",
      updatedAt: "2026-08-20T00:00:00.000Z",
      baseRefName: "main",
      headRefName: "feature",
      additions: 1,
      deletions: 0,
      changedFiles: 1,
      labels: [],
      assignees: [],
      reviewDecision: "",
      mergeStateStatus: "CLEAN",
      reviewRequests: [],
      checks: [],
      comments: [],
      reviews: [],
      reviewThreads: [],
      files: [],
    };
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thr-picker", params: null },
      {
        rpc: {
          pullForThread: () => ({ pull: null }),
          listItems: () => ({
            items: [
              {
                repo: "acme/widgets",
                number: 42,
                kind: "pr",
                title: "Linkable PR",
                state: "OPEN",
                author: "octocat",
                labels: [],
                assignees: [],
                url: pull.url,
                body: "",
                updatedAt: pull.updatedAt,
              },
            ],
          }),
          listLinks: () => ({ links: {} }),
          linkPullToThread: () =>
            new Promise((resolve) => {
              resolveLink = resolve;
            }),
          getPull: () => ({ pull }),
        },
      },
    ) as any;

    await act(async () => {});
    await slot.getByText("Linkable PR").click();
    await act(async () => {});
    expect(slot.rpcCalls).toContainEqual({
      method: "linkPullToThread",
      input: { threadId: "thr-picker", repo: "acme/widgets", number: 42 },
    });
    expect(slot.getByText("Linking pull request…")).toBeTruthy();
    expect(resolveLink).toBeDefined();

    await act(async () => {
      resolveLink?.({ ok: true });
    });
    expect(slot.rpcCalls).toContainEqual({
      method: "getPull",
      input: { repo: "acme/widgets", number: 42 },
    });
    slot.lifecycle.unmount();
  });

  it("clears a pending PR link when the thread route changes", async () => {
    let resolveLink: ((value: unknown) => void) | undefined;
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thr-old", params: null },
      {
        rpc: {
          pullForThread: () => ({ pull: null }),
          listItems: () => ({
            items: [
              {
                repo: "acme/widgets",
                number: 42,
                kind: "pr",
                title: "Linkable PR",
                state: "OPEN",
                author: "octocat",
                labels: [],
                assignees: [],
                url: "https://github.com/acme/widgets/pull/42",
                body: "",
                updatedAt: "2026-08-20T00:00:00.000Z",
              },
            ],
          }),
          listLinks: () => ({ links: {} }),
          linkPullToThread: () =>
            new Promise((resolve) => {
              resolveLink = resolve;
            }),
        },
      },
    ) as any;

    await act(async () => {});
    await slot.getByText("Linkable PR").click();
    await act(async () => {});
    expect(slot.getByText("Linking pull request…")).toBeTruthy();

    slot.lifecycle.rerender(
      createElement(app.threadPanelActions[0]!.component as any, {
        threadId: "thr-new",
        params: null,
      }),
    );
    await act(async () => {});
    expect(slot.queryByText("Linking pull request…")).toBeNull();
    const picker = slot.getByText("Linkable PR").closest("button");
    expect(picker).toBeTruthy();
    expect((picker as HTMLButtonElement).disabled).toBe(false);

    resolveLink?.({ ok: true });
    slot.lifecycle.unmount();
  });

});

describe("GitHub loading states", () => {
  const readyStatus = {
    ghOk: true,
    ghState: "ready",
    ghError: null,
    repos: [],
    lastSyncedAt: null,
  };

  function issueItem(title: string, number = 1) {
    return {
      repo: "acme/widgets",
      number,
      kind: "issue" as const,
      title,
      state: "OPEN",
      author: "octocat",
      labels: [],
      assignees: [],
      url: `https://github.com/acme/widgets/issues/${number}`,
      body: "",
      updatedAt: "2026-08-20T00:00:00.000Z",
    };
  }

  it("shows an issues skeleton immediately while the list is pending", async () => {
    let resolveItems: ((value: unknown) => void) | undefined;
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "issues" },
      {
        rpc: {
          status: () => readyStatus,
          listItems: () =>
            new Promise((resolve) => {
              resolveItems = resolve;
            }),
          listLinks: () => ({ links: {} }),
          viewer: () => ({ login: "octocat" }),
        },
      },
    ) as any;

    await act(async () => {});
    expect(slot.getByRole("status", { name: "Loading issues" })).toBeTruthy();
    await act(async () => {
      resolveItems?.({ items: [] });
    });
    slot.lifecycle.unmount();
  });

  it("keeps cached issue rows visible while a refresh is in flight", async () => {
    let listCalls = 0;
    let resolveRefresh: ((value: unknown) => void) | undefined;
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "issues" },
      {
        rpc: {
          status: () => readyStatus,
          listItems: () => {
            listCalls += 1;
            if (listCalls === 1) return { items: [issueItem("Cached issue")] };
            return new Promise((resolve) => {
              resolveRefresh = resolve;
            });
          },
          listLinks: () => ({ links: {} }),
          viewer: () => ({ login: "octocat" }),
        },
      },
    ) as any;

    await act(async () => {});
    expect(slot.getByText("Cached issue")).toBeTruthy();

    await slot.behavior.emitRealtime("data-changed", {});
    await act(async () => {});
    expect(slot.getByText("Cached issue")).toBeTruthy();
    expect(slot.queryByRole("status", { name: "Loading issues" })).toBeNull();
    expect(slot.getByText("Updating")).toBeTruthy();
    expect(resolveRefresh).toBeDefined();

    await act(async () => {
      resolveRefresh?.({ items: [issueItem("Fresh issue", 2)] });
    });
    expect(slot.getByText("Fresh issue")).toBeTruthy();
    expect(slot.queryByText("Cached issue")).toBeNull();
    expect(slot.queryByText("Updating")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("shows a checking state in the panel header before status arrives", async () => {
    const header = app.navPanels[0]!.headerContent;
    expect(header).toBeDefined();
    let resolveStatus: ((value: unknown) => void) | undefined;
    const slot = renderSlot(
      { component: header! },
      { subPath: "issues" },
      {
        rpc: {
          status: () =>
            new Promise((resolve) => {
              resolveStatus = resolve;
            }),
        },
      },
    ) as any;

    await act(async () => {});
    expect(slot.getByText("Checking GitHub…")).toBeTruthy();
    await act(async () => {
      resolveStatus?.(readyStatus);
    });
    slot.lifecycle.unmount();
  });

  it("shows Dependabot stat skeletons while alerts are loading", async () => {
    let resolveAlerts: ((value: unknown) => void) | undefined;
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "dependabot" },
      {
        rpc: {
          status: () => readyStatus,
          listDependabotAlerts: () =>
            new Promise((resolve) => {
              resolveAlerts = resolve;
            }),
          viewer: () => ({ login: "octocat" }),
        },
      },
    ) as any;

    await act(async () => {});
    expect(slot.getByRole("status", { name: "Loading Dependabot alerts" })).toBeTruthy();
    expect(slot.getByText("High / critical")).toBeTruthy();
    await act(async () => {
      resolveAlerts?.({
        alerts: [],
        errors: [],
        stats: { totalCount: 0, highCriticalCount: 0, withFixCount: 0, withoutFixCount: 0 },
      });
    });
    slot.lifecycle.unmount();
  });

  it("shows a compact skeleton while a thread pull lookup is pending", async () => {
    let resolvePull: ((value: unknown) => void) | undefined;
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thr-loading", params: null },
      {
        rpc: {
          pullForThread: () =>
            new Promise((resolve) => {
              resolvePull = resolve;
            }),
        },
      },
    ) as any;

    await act(async () => {});
    expect(slot.getByRole("status", { name: "Loading linked pull request" })).toBeTruthy();
    await act(async () => {
      resolvePull?.({ pull: null });
    });
    slot.lifecycle.unmount();
  });
});

describe("GitHub list UX", () => {
  const readyStatus = {
    ghOk: true,
    ghState: "ready",
    ghError: null,
    repos: [{
      repo: "acme/widgets",
      projectId: null,
      health: { status: "healthy", lastAttemptAt: null, lastSuccessAt: null, itemCount: 1, alertCount: 0, error: null },
    }],
    lastSyncedAt: "2026-08-20T00:00:00.000Z",
  };

  function issueItem(title: string, number: number, extra: Record<string, unknown> = {}) {
    return {
      repo: "acme/widgets",
      number,
      kind: "issue" as const,
      title,
      state: "OPEN",
      author: "octocat",
      labels: [],
      assignees: [],
      url: `https://github.com/acme/widgets/issues/${number}`,
      body: "",
      updatedAt: "2026-08-20T00:00:00.000Z",
      ...extra,
    };
  }

  beforeEach(() => {
    window.localStorage.clear();
  });

  it("toggles quick filters into the query and focuses the filter from slash", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "issues" },
      {
        rpc: {
          status: () => readyStatus,
          listItems: () => ({ items: [issueItem("Cache bug", 7)] }),
          listLinks: () => ({ links: {} }),
          viewer: () => ({ login: "octocat" }),
        },
      },
    ) as any;

    await act(async () => {});
    const filters = Array.from(
      slot.container.querySelectorAll('[role="group"][aria-label="Quick filters"]') as NodeListOf<HTMLElement>,
    ).find((group) => {
      const buttons = Array.from(group.querySelectorAll("button")) as HTMLButtonElement[];
      return buttons.map((button) => button.textContent?.trim()).join(",") === "Open,Closed,Assigned to me";
    });
    expect(filters).toBeTruthy();
    expect(filters?.querySelector('[aria-pressed="true"]')?.textContent).toBe("Open");
    const issuePanel = filters?.closest('[role="tabpanel"]');
    const assignedFilter = Array.from(filters!.querySelectorAll("button") as NodeListOf<HTMLButtonElement>).find(
      (button) => button.textContent?.trim() === "Assigned to me",
    )!;
    await assignedFilter.click();
    const input = issuePanel?.querySelector(
      '[role="combobox"][aria-label="Filter issues"]',
    ) as HTMLInputElement;
    expect(input.value).toBe("is:open assignee:@me");

    input.blur();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "/", bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(input);
    slot.lifecycle.unmount();
  });

  it("opens an issue from the row, not only the title control", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "issues" },
      {
        rpc: {
          status: () => readyStatus,
          listItems: () => ({ items: [issueItem("Row click target", 42)] }),
          listLinks: () => ({ links: {} }),
          viewer: () => ({ login: "octocat" }),
        },
      },
    ) as any;

    await act(async () => {});
    await slot.getByText("#42").click();
    expect(slot.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "github",
      options: { subPath: "issues/acme/widgets/42" },
    });
    slot.lifecycle.unmount();
  });

  it("paginates long issue lists", async () => {
    const items = Array.from({ length: 26 }, (_, index) => issueItem(`Issue ${index + 1}`, index + 1));
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "issues" },
      {
        rpc: {
          status: () => readyStatus,
          listItems: () => ({ items }),
          listLinks: () => ({ links: {} }),
          viewer: () => ({ login: "octocat" }),
        },
      },
    ) as any;

    await act(async () => {});
    expect(slot.getByText("Showing 1–25 of 26")).toBeTruthy();
    expect(slot.queryByText("Issue 26")).toBeNull();
    await slot.getByRole("button", { name: "Next" }).click();
    expect(slot.getByText("Issue 26")).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("turns Dependabot summary cards into severity and fix filters", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "dependabot" },
      {
        rpc: {
          status: () => readyStatus,
          viewer: () => ({ login: "octocat" }),
          listDependabotAlerts: () => ({
            alerts: [{
              repo: "acme/widgets",
              number: 3,
              state: "open",
              severity: "high",
              packageName: "left-pad",
              ecosystem: "npm",
              summary: "bad pad",
              vulnerableVersionRange: "<1.0.0",
              firstPatchedVersion: "1.0.1",
              updatedAt: "2026-08-20T00:00:00.000Z",
            }],
            errors: [],
            stats: { totalCount: 1, highCriticalCount: 1, withFixCount: 1, withoutFixCount: 0 },
          }),
        },
      },
    ) as any;

    await act(async () => {});
    await slot.getByRole("button", { name: "High / critical" }).click();
    expect((slot.getByRole("combobox", { name: "Filter alerts" }) as HTMLInputElement).value).toBe(
      "is:open severity:high severity:critical",
    );
    slot.lifecycle.unmount();
  });
});
