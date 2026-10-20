// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { cleanup, fireEvent } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { AutomationDashboard, JobRecord } from "./automation/domain";
import { automationRpcMethods, type JobPage } from "./automation/schemas";

afterEach(() => { cleanup(); window.localStorage.clear(); });

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
  issueNumber: null,
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
    automationListJobs: (input: unknown) => {
      const { repo, offset, limit } = automationRpcMethods.automationListJobs.input.parse(input);
      const jobs = dashboard.jobs.filter((job) => !repo || job.repo === repo);
      return { jobs: jobs.slice(offset, offset + limit), total: jobs.length, audit: dashboard.audit };
    },
    ...extra,
  };
}

describe("GitHub+ automation tab", () => {
  it("registers the automation result-card directive", () => {
    expect(app.messageDirectives.map((directive) => directive.id)).toEqual(["github-automation"]);
  });

  it("keeps repository automation setup available under settings", async () => {
    const slot = renderSlot(app.navPanels[0]!, { subPath: "automation/setup" }, { rpc: rpcHandlers(makeDashboard()) }) as any;
    await act(async () => {});
    expect(slot.getByRole("tab", { name: "Automations" }).getAttribute("aria-selected")).toBe("true");
    await slot.findByText("Setup progress: 2 of 4");
    await slot.findByText("Enable automation for a repository");
    await slot.findByText("Dry run");
    const toggle = await slot.findByRole("switch", { name: "Enable automation for acme/widgets" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    slot.lifecycle.unmount();
  });

  it("navigates to Activity from the primary tabs", async () => {
    const slot = renderSlot(app.navPanels[0]!, { subPath: "automation" }, { rpc: rpcHandlers(makeDashboard()) });
    fireEvent.click(await slot.findByRole("tab", { name: "Activity" }));
    expect(slot.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "github", options: { subPath: "activity" } });
    slot.lifecycle.unmount();
  });

  it("renders rules with approval badges and starter templates", async () => {
    const slot = renderSlot(app.navPanels[0]!, { subPath: "automation/rules" }, { rpc: rpcHandlers(makeDashboard()) }) as any;
    await slot.findByText("Review opened and updated pull requests", { selector: "p" });
    fireEvent.click(slot.getByText("Starter templates", { selector: "summary" }));
    await slot.findByText("Approval");
    await slot.findByText("Starter templates");
    await slot.findByText("Update the local checkout after a merge");
    expect(slot.getByRole("switch", { name: "Enable Review opened and updated pull requests" })).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("edits label conditions while preserving advanced settings", async () => {
    const saved = makeDashboard();
    const save = vi.fn((input: unknown) => ({ saved: automationRpcMethods.automationSaveRules.input.parse(input).rules.length }));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "automation" }, { rpc: { ...rpcHandlers(saved), automationSaveRules: save } });
    fireEvent.click(await slot.findByRole("button", { name: /Review opened and updated pull requests.*action/ }));
    const labels = slot.getByLabelText("Only if all labels match");
    labels.focus();
    fireEvent.change(labels, { target: { value: "bug," } });
    expect(labels).toHaveProperty("value", "bug,");
    fireEvent.change(labels, { target: { value: "bug, urgent" } });
    fireEvent.click(slot.getByRole("button", { name: "Save rules" }));
    await vi.waitFor(() => expect(save).toHaveBeenCalledWith({ expectedRules: saved.rules, rules: [{ ...saved.rules[0], filters: { draft: false, labels: ["bug", "urgent"] } }] }));
  });

  it("adopts concurrent rule changes in a pristine JSON editor", async () => {
    const dashboard = makeDashboard();
    const save = vi.fn((input: unknown) => ({ saved: automationRpcMethods.automationSaveRules.input.parse(input).rules.length }));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "automation" }, { rpc: rpcHandlers(dashboard, { automationSaveRules: save }) });
    await slot.findByText("Review opened and updated pull requests", { selector: "p" });
    fireEvent.click(slot.getByText("Advanced", { selector: "summary" }));
    fireEvent.click(slot.getByRole("button", { name: "Edit JSON" }));
    dashboard.rules = [...dashboard.rules, { ...dashboard.rules[0]!, id: "remote-rule", name: "Created in another client", order: 99 }];
    await slot.behavior.emitRealtime("automation-changed", {});
    await vi.waitFor(() => expect(slot.getByRole("textbox", { name: "Rules as JSON" })).toHaveProperty("value", JSON.stringify(dashboard.rules, null, 2)));
    expect(slot.queryByRole("button", { name: "Save rules" })).toBeNull();
    const draft = dashboard.rules.map((rule) => rule.id === "review-opened" ? { ...rule, name: "Local name" } : rule);
    fireEvent.change(slot.getByRole("textbox", { name: "Rules as JSON" }), { target: { value: JSON.stringify(draft) } });
    fireEvent.click(slot.getByRole("button", { name: "Save rules" }));
    await vi.waitFor(() => expect(save).toHaveBeenCalledWith({ rules: draft, expectedRules: dashboard.rules }));
  });

  it("preserves dirty JSON and blocks a save after concurrent changes", async () => {
    const dashboard = makeDashboard();
    const save = vi.fn();
    const slot = renderSlot(app.navPanels[0]!, { subPath: "automation" }, { rpc: rpcHandlers(dashboard, { automationSaveRules: save }) });
    await slot.findByText("Review opened and updated pull requests", { selector: "p" });
    fireEvent.click(slot.getByText("Advanced", { selector: "summary" }));
    fireEvent.click(slot.getByRole("button", { name: "Edit JSON" }));
    const draft = JSON.stringify(dashboard.rules.map((rule) => ({ ...rule, name: "Unsaved local edit" })), null, 2);
    fireEvent.change(slot.getByRole("textbox", { name: "Rules as JSON" }), { target: { value: draft } });
    dashboard.rules = dashboard.rules.map((rule) => ({ ...rule, name: "Changed elsewhere" }));
    await slot.behavior.emitRealtime("automation-changed", {});
    await slot.findByText(/Automations changed elsewhere/);
    expect(slot.getByRole("textbox", { name: "Rules as JSON" })).toHaveProperty("value", draft);
    expect(slot.getByRole("button", { name: "Save rules" }).hasAttribute("disabled")).toBe(true);
    expect(save).not.toHaveBeenCalled();
  });

  it.each((["builder", "JSON"] as const).flatMap((mode) => [
    { mode, laterName: "Typed while saving" },
    { mode, laterName: "Review opened and updated pull requests" },
  ]))("retains $mode edits to '$laterName' while a save is pending", async ({ mode, laterName }) => {
    const dashboard = makeDashboard();
    const pending: { resolve?: () => void } = {};
    const firstSave = new Promise<void>((resolve) => { pending.resolve = resolve; });
    let saveCount = 0;
    const save = vi.fn(async (input: unknown) => {
      const { rules } = automationRpcMethods.automationSaveRules.input.parse(input);
      dashboard.rules = rules;
      if (++saveCount === 1) await firstSave;
      return { saved: rules.length };
    });
    const slot = renderSlot(app.navPanels[0]!, { subPath: "automation" }, { rpc: rpcHandlers(dashboard, { automationSaveRules: save }) });
    await slot.findByText("Review opened and updated pull requests", { selector: "p" });
    if (mode === "JSON") {
      fireEvent.click(slot.getByText("Advanced", { selector: "summary" }));
      fireEvent.click(slot.getByRole("button", { name: "Edit JSON" }));
    } else {
      fireEvent.click(slot.getByRole("button", { name: /Review opened and updated pull requests.*action/ }));
    }
    const submitted = dashboard.rules.map((rule) => ({ ...rule, name: "Submitted name" }));
    const later = submitted.map((rule) => ({ ...rule, name: laterName }));
    const changeDraft = (rules: typeof dashboard.rules) => fireEvent.change(
      slot.getByRole("textbox", { name: mode === "JSON" ? "Rules as JSON" : "Name" }),
      { target: { value: mode === "JSON" ? JSON.stringify(rules, null, 2) : rules[0]!.name } },
    );
    changeDraft(submitted);
    fireEvent.click(slot.getByRole("button", { name: "Save rules" }));
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    changeDraft(later);
    await slot.behavior.emitRealtime("automation-changed", {});
    await act(async () => { pending.resolve?.(); await firstSave; });
    await slot.findByRole("button", { name: "Save rules" });
    expect(slot.getByRole("textbox", { name: mode === "JSON" ? "Rules as JSON" : "Name" })).toHaveProperty(
      "value", mode === "JSON" ? JSON.stringify(later, null, 2) : laterName,
    );
    fireEvent.click(slot.getByRole("button", { name: "Save rules" }));
    await vi.waitFor(() => expect(save).toHaveBeenNthCalledWith(2, { rules: later, expectedRules: submitted }));
    await vi.waitFor(() => expect(slot.queryByRole("button", { name: "Save rules" })).toBeNull());
  });

  it.each(["builder", "JSON"] as const)("keeps a confirmed %s save if the dashboard refresh fails", async (mode) => {
    const dashboard = makeDashboard();
    const submitted = dashboard.rules.map((rule) => ({ ...rule, name: "Confirmed saved name" }));
    const pending: { resolve?: () => void } = {};
    const firstSave = new Promise<void>((resolve) => { pending.resolve = resolve; });
    let failRefresh = false;
    const save = vi.fn(async () => {
      await firstSave;
      failRefresh = true;
      return { saved: submitted.length };
    });
    const slot = renderSlot(app.navPanels[0]!, { subPath: "automation" }, { rpc: rpcHandlers(dashboard, {
      automationDashboard: () => {
        if (failRefresh) throw new Error("Dashboard temporarily unavailable");
        return { ...dashboard, rules: structuredClone(dashboard.rules) };
      },
      automationSaveRules: save,
    }) });
    await slot.findByText("Review opened and updated pull requests", { selector: "p" });
    if (mode === "JSON") {
      fireEvent.click(slot.getByText("Advanced", { selector: "summary" }));
      fireEvent.click(slot.getByRole("button", { name: "Edit JSON" }));
    } else {
      fireEvent.click(slot.getByRole("button", { name: /Review opened and updated pull requests.*action/ }));
    }
    fireEvent.change(slot.getByRole("textbox", { name: mode === "JSON" ? "Rules as JSON" : "Name" }), {
      target: { value: mode === "JSON" ? JSON.stringify(submitted, null, 2) : submitted[0]!.name },
    });
    fireEvent.click(slot.getByRole("button", { name: "Save rules" }));
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    await slot.behavior.emitRealtime("automation-changed", {});
    await act(async () => { pending.resolve?.(); await firstSave; });
    await slot.findByText(/Could not refresh: Dashboard temporarily unavailable/);
    await vi.waitFor(() => expect(slot.container.querySelector(".gh-automations")?.getAttribute("aria-busy")).toBeNull());
    expect(slot.getByRole("textbox", { name: mode === "JSON" ? "Rules as JSON" : "Name" })).toHaveProperty(
      "value", mode === "JSON" ? JSON.stringify(submitted, null, 2) : submitted[0]!.name,
    );
    expect(slot.queryByRole("button", { name: "Save rules" })).toBeNull();
    failRefresh = false;
    dashboard.rules = submitted;
    fireEvent.click(slot.getByRole("button", { name: "Retry" }));
    await vi.waitFor(() => expect(slot.queryByText(/Could not refresh:/)).toBeNull());
  });

  it("persists a saved rule switch immediately while retaining another draft edit", async () => {
    const dashboard = makeDashboard();
    dashboard.rules = [...dashboard.rules, { ...dashboard.rules[0]!, id: "active-rule", name: "Active automation", enabled: true, order: 20 }];
    const toggle = vi.fn((input: unknown) => {
      const { id, enabled } = automationRpcMethods.automationSetRuleEnabled.input.parse(input);
      dashboard.rules = dashboard.rules.map((rule) => rule.id === id ? { ...rule, enabled } : rule);
      return { ok: true };
    });
    const save = vi.fn((input: unknown) => ({ saved: automationRpcMethods.automationSaveRules.input.parse(input).rules.length }));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "automation" }, { rpc: rpcHandlers(dashboard, { automationSetRuleEnabled: toggle, automationSaveRules: save }) });
    fireEvent.click(await slot.findByRole("button", { name: /Review opened and updated pull requests.*action/ }));
    fireEvent.change(slot.getByLabelText("Name"), { target: { value: "Draft automation name" } });
    fireEvent.click(slot.getByRole("switch", { name: "Disable Active automation" }));
    await vi.waitFor(() => expect(toggle).toHaveBeenCalledWith({ id: "active-rule", enabled: false }));
    await vi.waitFor(() => expect(slot.getByRole("switch", { name: "Enable Active automation" }).getAttribute("aria-checked")).toBe("false"));
    expect(slot.getByLabelText("Name")).toHaveProperty("value", "Draft automation name");
    fireEvent.click(slot.getByRole("button", { name: "Save rules" }));
    await vi.waitFor(() => expect(save).toHaveBeenCalledWith({
      expectedRules: dashboard.rules,
      rules: dashboard.rules.map((rule) => rule.id === "review-opened" ? { ...rule, name: "Draft automation name" } : rule),
    }));
  });

  it("adds, saves, reopens, and removes a custom agent action from Something else", async () => {
    const dashboard = makeDashboard();
    const save = vi.fn((input: unknown) => {
      const { rules } = automationRpcMethods.automationSaveRules.input.parse(input);
      dashboard.rules = rules;
      return { saved: rules.length };
    });
    const slot = renderSlot(app.navPanels[0]!, { subPath: "automation/rules" }, {
      rpc: { ...rpcHandlers(dashboard), automationSaveRules: save },
    });
    const rule = await slot.findByRole("button", { name: /Review opened and updated pull requests.*action/ });
    fireEvent.click(rule);
    fireEvent.click(slot.getByText("Advanced: multiple triggers, actions and conditions", { selector: "summary" }));
    await slot.findByRole("button", { name: "Something else?" });
    fireEvent.click(slot.getByRole("button", { name: "Something else?" }));
    const prompt = slot.getByRole("textbox", { name: "What should the agent do?" });
    fireEvent.change(prompt, { target: { value: "Investigate failing CI and open a pull request with the fix." } });
    fireEvent.click(slot.getByRole("button", { name: "Save rules" }));
    await vi.waitFor(() => expect(save).toHaveBeenCalledWith({ expectedRules: expect.any(Array), rules: [expect.objectContaining({
      actions: ["bb.review", "github.review", "bb.agent"],
      actionParameters: { bodyTemplate: "{{review}}", agentPrompt: "Investigate failing CI and open a pull request with the fix." },
      approvalRequired: true,
    })] }));
    expect(slot.getByRole("textbox", { name: "What should the agent do?" })).toHaveProperty("value", "Investigate failing CI and open a pull request with the fix.");
    expect(slot.queryByRole("button", { name: "Something else?" })).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Remove Run agent" }));
    expect(slot.queryByRole("textbox", { name: "What should the agent do?" })).toBeNull();
    expect(slot.getByRole("button", { name: "Something else?" })).toBeTruthy();
    slot.lifecycle.unmount();
  }, 15_000);

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
    expect(slot.getByRole("tab", { name: "Activity" }).getAttribute("aria-selected")).toBe("true");
    slot.lifecycle.unmount();
  });

  it("returns to a valid Activity page when a refresh removes the final page", async () => {
    const dashboard = makeDashboard({ jobs: Array.from({ length: 55 }, (_, index) => ({ ...pendingJob, id: index + 1, title: `Run ${index + 1}` })) });
    const list = vi.fn(rpcHandlers(dashboard).automationListJobs);
    const slot = renderSlot(app.navPanels[0]!, { subPath: "activity" }, { rpc: rpcHandlers(dashboard, { automationListJobs: list }) });
    await slot.findByText("Job 1");
    fireEvent.click(slot.getAllByRole("button", { name: "Last page" })[0]!);
    await slot.findByText("Job 55");
    expect(list).toHaveBeenCalledWith({ offset: 50, limit: 25 });
    dashboard.jobs = dashboard.jobs.slice(0, 3);
    await slot.behavior.emitRealtime("automation-changed", {});
    await slot.findByText("Job 1");
    expect(slot.queryByText("Job 55")).toBeNull();
    expect(slot.queryByText("No events yet")).toBeNull();
    expect(list).toHaveBeenLastCalledWith({ offset: 0, limit: 25 });
  });

  it("ignores delayed Activity responses from a previous repository", async () => {
    localStorage.setItem("github-extended:repository", "acme/widgets");
    const pending: { resolve?: (page: JobPage) => void } = {};
    const delayed = new Promise<JobPage>((resolve) => { pending.resolve = resolve; });
    const list = vi.fn((input: unknown) => {
      const { repo } = automationRpcMethods.automationListJobs.input.parse(input);
      return repo === "acme/widgets" ? delayed : { jobs: [{ ...pendingJob, repo: "acme/other", title: "Other repository run" }], total: 1, audit: [] };
    });
    const slot = renderSlot(app.navPanels[0]!, { subPath: "activity" }, { rpc: rpcHandlers(makeDashboard(), {
      status: () => ({ ...status, repos: [...status.repos, { ...status.repos[0]!, repo: "acme/other" }] }),
      automationListJobs: list,
    }) });
    await vi.waitFor(() => expect(list).toHaveBeenCalledWith({ repo: "acme/widgets", offset: 0, limit: 25 }));
    fireEvent.change(slot.getByRole("combobox", { name: "Repository scope" }), { target: { value: "acme/other" } });
    await slot.findByText("Other repository run");
    await act(async () => { pending.resolve?.({ jobs: [pendingJob], total: 1, audit: [] }); });
    expect(slot.getByText("Other repository run")).toBeTruthy();
    expect(slot.queryByText("Add widgets")).toBeNull();
    expect(list).toHaveBeenLastCalledWith({ repo: "acme/other", offset: 0, limit: 25 });
  });

  it("offers issue triggers and saves an issue agent action without PR-only reviews", async () => {
    const save = vi.fn((input: unknown) => ({ saved: automationRpcMethods.automationSaveRules.input.parse(input).rules.length }));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "automation/rules" }, {
      rpc: { ...rpcHandlers(makeDashboard()), automationSaveRules: save },
    });
    fireEvent.click(await slot.findByRole("button", { name: /Review opened and updated pull requests.*action/ }));
    fireEvent.click(slot.getByText("Advanced: multiple triggers, actions and conditions", { selector: "summary" }));
    await slot.findByLabelText("Issue opened: A new issue is opened.");
    for (const label of ["Issue opened", "Issue edited", "Issue closed", "Issue reopened", "Issue labeled", "Issue unlabeled", "Issue assigned", "Issue unassigned"]) {
      expect(slot.getByLabelText(new RegExp(`^${label}:`))).toBeTruthy();
    }
    fireEvent.click(slot.getByLabelText("Issue opened: A new issue is opened."));
    expect(slot.queryByLabelText("Remove BB agent review")).toBeNull();
    expect(slot.queryByLabelText("Remove Post PR review")).toBeNull();
    expect(slot.queryByLabelText("Add action: Submit a review comment on the pull request.")).toBeNull();
    fireEvent.click(slot.getByLabelText("PR opened: A pull request is opened."));
    fireEvent.click(slot.getByLabelText("PR updated: New commits land on a pull request."));
    fireEvent.click(slot.getByText("Something else?", { selector: "button" }));
    fireEvent.change(slot.container.querySelector("textarea[id^=agent-prompt-]")!, { target: { value: "Investigate the issue and propose a fix." } });
    fireEvent.click(slot.getByText("Save rules", { selector: "button" }));
    await vi.waitFor(() => expect(save).toHaveBeenCalledWith({ expectedRules: expect.any(Array), rules: [expect.objectContaining({
      events: ["issue.opened"], actions: ["bb.agent"],
      actionParameters: expect.objectContaining({ agentPrompt: "Investigate the issue and propose a fix." }),
    })] }));
    slot.lifecycle.unmount();
  }, 15_000);

  it("shows the issue number on the event queue", async () => {
    const slot = renderSlot(app.navPanels[0]!, { subPath: "automation/events" }, {
      rpc: rpcHandlers(makeDashboard({ jobs: [{ ...pendingJob, kind: "issue.opened", prNumber: null, issueNumber: 8 }] })),
    });
    await slot.findByText("Job 7");
    expect(slot.container.textContent).toContain("acme/widgets#8");
    expect(slot.container.textContent).toContain("Issue opened");
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

  it("creates automations through the native AI composer with a manual fallback", async () => {
    const slot = renderSlot(app.navPanels[0]!, { subPath: "automation/create" }, { rpc: rpcHandlers(makeDashboard()) });
    await slot.findByText("Create automation", { selector: "h2" });
    expect(slot.getByTestId("bb-new-thread-composer")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Build manually" }));
    await slot.findByLabelText("When");
    expect(slot.getByLabelText("Automation summary").textContent).toContain("Ask for approval");
    slot.lifecycle.unmount();
  });
});
