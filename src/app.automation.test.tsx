// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { AutomationDashboard, JobRecord } from "./automation/domain";

const app = await loadPluginApp(() => import("./app"));

const status = {
  ghOk: true,
  ghState: "ready",
  ghError: null,
  repos: [{
    repo: "acme/widgets",
    projectId: null,
    health: { status: "healthy", lastAttemptAt: null, lastSuccessAt: null, itemCount: 1, alertCount: 0, error: null },
  }],
  lastSyncedAt: null,
  syncing: false,
};

const pendingJob: JobRecord = {
  id: 7,
  deliveryId: "poll:acme/widgets:pr.opened:5",
  repo: "acme/widgets",
  kind: "pr.opened",
  prNumber: 5,
  title: "Add widgets",
  status: "pending_approval",
  attempts: 1,
  approved: false,
  error: null,
  matchedRules: ["Review opened and updated pull requests"],
  actions: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function makeDashboard(overrides: Partial<AutomationDashboard> = {}): AutomationDashboard {
  return {
    dryRun: true,
    repositories: [{ repo: "acme/widgets", enabled: false, baseBranch: "main", projectId: null, checkoutPath: null }],
    enabledRepositoryCount: 0,
    rules: [{
      id: "review-opened",
      name: "Review opened and updated pull requests",
      enabled: false,
      order: 10,
      events: ["pr.opened", "pr.synchronised"],
      repos: [],
      filters: { draft: false },
      conditionGroups: [],
      actions: ["bb.review", "github.review"],
      actionParameters: { bodyTemplate: "{{review}}" },
      approvalRequired: true,
    }],
    jobs: [],
    pendingApprovals: 0,
    audit: [],
    poll: {
      enabled: true,
      intervalSeconds: 300,
      inProgress: false,
      lastStartedAt: null,
      lastFinishedAt: null,
      lastError: null,
      lastQueued: 0,
      nextAt: null,
      autoPaused: false,
      quotaPauseRemaining: 100,
      resumeAt: null,
      repositories: [],
    },
    quota: {
      available: true,
      login: "octocat",
      checkedAt: new Date().toISOString(),
      error: null,
      graphql: { limit: 5000, remaining: 4307, used: 693, resetAt: new Date(Date.now() + 3_600_000).toISOString(), cost: 1 },
      rest: { limit: 5000, remaining: 4992, used: 8, resetAt: new Date(Date.now() + 3_600_000).toISOString() },
    },
    ...overrides,
  };
}

function rpcHandlers(dashboard: AutomationDashboard, extra: Record<string, (input?: unknown) => unknown> = {}) {
  return {
    status: () => status,
    viewer: () => ({ login: "octocat" }),
    listItems: () => ({ items: [] }),
    listLinks: () => ({ links: {} }),
    automationDashboard: () => dashboard,
    ...extra,
  };
}

describe("GitHub+ automation tab", () => {
  it("registers the automation result-card directive", () => {
    expect(app.messageDirectives.map((directive) => directive.id)).toEqual(["github-automation"]);
  });

  it("selects the Automation tab and renders the setup checklist with repository toggles", async () => {
    const slot = renderSlot(app.navPanels[0]!, { subPath: "automation" }, { rpc: rpcHandlers(makeDashboard()) }) as any;
    await act(async () => {});
    expect(slot.getByRole("tab", { name: "Automation" }).getAttribute("aria-selected")).toBe("true");
    await slot.findByText("Setup progress: 2 of 4");
    await slot.findByText("Enable automation for a repository");
    await slot.findByText("Dry run");
    const toggle = await slot.findByRole("switch", { name: "Enable automation for acme/widgets" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    slot.lifecycle.unmount();
  });

  it("navigates between automation pages through the URL-backed sub-path", async () => {
    const slot = renderSlot(app.navPanels[0]!, { subPath: "automation" }, { rpc: rpcHandlers(makeDashboard()) }) as any;
    await slot.findByText("Setup progress: 2 of 4");
    (await slot.findByRole("button", { name: "Events" })).click();
    expect(slot.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "github",
      options: { subPath: "automation/events" },
    });
    slot.lifecycle.unmount();
  });

  it("renders rules with approval badges and starter templates", async () => {
    const slot = renderSlot(app.navPanels[0]!, { subPath: "automation/rules" }, { rpc: rpcHandlers(makeDashboard()) }) as any;
    // The saved rule row and the starter template card share this name.
    expect(await slot.findAllByText("Review opened and updated pull requests")).toHaveLength(2);
    await slot.findByText("Approval");
    await slot.findByText("Starter templates");
    await slot.findByText("Update the local checkout after a merge");
    expect(slot.getByRole("switch", { name: "Enable Review opened and updated pull requests" })).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("surfaces pending approvals on the events page with an approve action", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "automation/events" },
      { rpc: rpcHandlers(makeDashboard({ jobs: [pendingJob], pendingApprovals: 1 })) },
    ) as any;
    await slot.findByText("Job 7");
    await slot.findByText("Needs approval");
    await slot.findByText("Add widgets");
    await slot.findByRole("button", { name: "Approve and run" });
    const eventsNav = slot
      .getAllByRole("button")
      .find((button: HTMLElement) => button.getAttribute("aria-current") === "page");
    expect(eventsNav?.textContent).toContain("Events");
    expect(eventsNav?.textContent).toContain("1");
    slot.lifecycle.unmount();
  });

  it("shows quota meters and lets the user pick a poll interval", async () => {
    let savedInterval: number | null = null;
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "automation/polling" },
      {
        rpc: rpcHandlers(makeDashboard({ enabledRepositoryCount: 1 }), {
          automationSetPolling: (input?: unknown) => {
            savedInterval = (input as { intervalSeconds: number }).intervalSeconds;
            return { enabled: true, intervalSeconds: savedInterval, quotaPauseRemaining: 100 };
          },
        }),
      },
    ) as any;
    await slot.findByText("GitHub CLI polling");
    await slot.findByText("4,307 / 5,000");
    await slot.findByText("4,992 / 5,000");
    (await slot.findByRole("button", { name: "15m" })).click();
    await vi.waitFor(() => expect(savedInterval).toBe(900));
    slot.lifecycle.unmount();
  });

  it("renders the result card and opens the rules page from it", async () => {
    const slot = renderSlot(
      app.messageDirectives[0]!,
      {
        attributes: { status: "success", title: "Rule created", repository: "acme/widgets", page: "rules" },
        source: '::github-automation{status="success"}',
        message: { id: "message-1", threadId: "thread-1", turnId: "turn-1", projectId: "project-1" },
        openWorkspaceFile: null,
      },
      {},
    ) as any;
    expect(slot.getByText("Rule created")).toBeTruthy();
    expect(slot.getByText("acme/widgets")).toBeTruthy();
    slot.getByRole("button", { name: "Open rules" }).click();
    expect(slot.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "github",
      options: { subPath: "automation/rules" },
    });
    slot.lifecycle.unmount();
  });

  it("opens the events page from the pending-approvals summary", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "automation" },
      { rpc: rpcHandlers(makeDashboard({ pendingApprovals: 2 })) },
    ) as any;
    await slot.findByText("Setup progress: 2 of 4");
    (await slot.findByRole("button", { name: "Open events, 2 pending approvals" })).click();
    expect(slot.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "github",
      options: { subPath: "automation/events" },
    });
    slot.lifecycle.unmount();
  });
});
