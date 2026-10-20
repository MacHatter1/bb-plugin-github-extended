// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { cleanup, fireEvent, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { AgentComposer, AgentTaskView, AskAgent } from "./agent-task";
import type { AutomationDashboard, JobRecord } from "./automation/domain";
import { githubRpcContract, type DependabotAlert } from "./server";
import type { Item } from "./app-logic";

const app = await loadPluginApp(() => import("./app"));
afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
  localStorage.clear();
});
const repositories = ["acme/widgets", "acme/other"].map((repo) => ({
  repo,
  projectId: "project-widgets",
  health: {
    status: "healthy",
    lastAttemptAt: null,
    lastSuccessAt: null,
    itemCount: 1,
    alertCount: 1,
    error: null,
  },
}));
const status = {
  ghOk: true,
  ghState: "ready",
  ghError: null,
  repos: repositories,
  lastSyncedAt: null,
  syncing: false,
};
const job: JobRecord = {
  id: 7,
  deliveryId: "issue-7",
  repo: "acme/widgets",
  kind: "issue.opened",
  prNumber: null,
  issueNumber: 7,
  title: "Investigate a bug",
  status: "pending_approval",
  attempts: 1,
  approved: false,
  error: null,
  matchedRules: ["Investigate bugs"],
  actions: [],
  createdAt: "2026-10-20T12:00:00Z",
  updatedAt: "2026-10-20T12:00:00Z",
};
function dashboard(): AutomationDashboard {
  return {
    dryRun: true,
    repositories: [],
    enabledRepositoryCount: 0,
    rules: [],
    jobs: [job],
    pendingApprovals: 1,
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
      login: null,
      checkedAt: null,
      error: null,
      graphql: null,
      rest: null,
    },
  };
}
function item(
  number: number,
  kind: Item["kind"],
  state = "OPEN",
  repo = "acme/widgets",
): Item {
  return {
    number,
    repo,
    kind,
    state,
    title: `${kind} ${number}`,
    author: "alex",
    labels: [],
    assignees: [],
    url: `https://github.com/${repo}/issues/${number}`,
    body: "",
    updatedAt: "2026-10-20T12:00:00Z",
  };
}
function alert(number: number, severity = "critical"): DependabotAlert {
  return {
    repo: "acme/widgets",
    number,
    state: "open",
    severity,
    packageName: "widgets",
    ecosystem: "npm",
    vulnerableVersionRange: "<2",
    firstPatchedVersion: "2",
    summary: `Security ${number}`,
    htmlUrl: "https://github.com/acme/widgets/security/dependabot/1",
    createdAt: "2026-10-20T12:00:00Z",
    updatedAt: "2026-10-20T12:00:00Z",
    dismissedReason: null,
    dismissedAt: null,
    fixedAt: null,
  };
}
function jobPage(data: AutomationDashboard, input: unknown) {
  const { repo, offset, limit } = githubRpcContract.automationListJobs.input.parse(input);
  const jobs = data.jobs.filter((job) => !repo || job.repo === repo);
  return { jobs: jobs.slice(offset, offset + limit), total: jobs.length, audit: data.audit };
}
const handlers = () => ({
  status: () => status,
  automationDashboard: () => dashboard(),
  automationListJobs: (input: unknown) => jobPage(dashboard(), input),
  listLinks: () => ({ links: {} }),
  listItems: (input: unknown) => ({
    items:
      githubRpcContract.listItems.input.parse(input).kind === "issue"
        ? [
            item(1, "issue"),
            item(2, "issue", "CLOSED"),
            item(3, "issue", "OPEN", "acme/other"),
          ]
        : [item(4, "pr")],
  }),
  listDependabotAlerts: () => ({
    alerts: [alert(5), alert(6, "low")],
    errors: [],
    stats: {
      totalCount: 2,
      highCriticalCount: 1,
      withFixCount: 2,
      withoutFixCount: 0,
    },
  }),
});

describe("simplified GitHub workflows", () => {
  it("combines actionable items and approvals, then reveals other states with Everything", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      { rpc: handlers() },
    );
    await slot.findByText("issue 1");
    expect(slot.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Inbox",
      "Automations",
      "Activity",
    ]);
    expect(slot.getByText("pr 4")).toBeTruthy();
    expect(slot.getByText("Security 5")).toBeTruthy();
    expect(slot.getByRole("button", { name: "Approve and run" })).toBeTruthy();
    expect(slot.queryByText("issue 2")).toBeNull();
    expect(slot.queryByText("Security 6")).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Everything" }));
    expect(slot.getByText("issue 2")).toBeTruthy();
    expect(slot.getByText("Security 6")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: /^Pull requests$/ }));
    expect(slot.queryByText("issue 1")).toBeNull();
    expect(slot.queryByText("Security 5")).toBeNull();
    expect(slot.getByText("pr 4")).toBeTruthy();
  });

  it("paginates security and work items independently from either end of each list", async () => {
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: {
      ...handlers(),
      listItems: (input: unknown) => ({ items: githubRpcContract.listItems.input.parse(input).kind === "issue"
        ? Array.from({ length: 55 }, (_, index) => item(index + 1, "issue")) : [] }),
      listDependabotAlerts: () => ({ ...handlers().listDependabotAlerts(), alerts: Array.from({ length: 53 }, (_, index) => alert(index + 1)) }),
    } });
    await slot.findByText("Security 1");
    expect(slot.getByText("issue 1")).toBeTruthy();
    expect(slot.queryByText("Security 26")).toBeNull();
    expect(slot.queryByText("issue 26")).toBeNull();
    const security = within(slot.getByRole("navigation", { name: "Security alerts pagination" }));
    expect(security.getByText("Showing 1–25 of 53")).toBeTruthy();
    expect(security.getByRole("button", { name: "Previous page" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(security.getByRole("button", { name: "Next page" }));
    expect(slot.getByText("Security 26")).toBeTruthy();
    expect(slot.queryByText("Security 1")).toBeNull();
    expect(slot.getByText("issue 1")).toBeTruthy();
    const scrollToStart = vi.fn();
    slot.getByRole("navigation", { name: "Issues and pull requests pagination" }).scrollIntoView = scrollToStart;
    const work = within(slot.getByRole("navigation", { name: "Issues and pull requests pagination (bottom)" }));
    fireEvent.click(work.getByRole("button", { name: "Last page" }));
    expect(slot.getByText("issue 55")).toBeTruthy();
    expect(scrollToStart).toHaveBeenCalledWith({ block: "start" });
    expect(slot.queryByText("issue 1")).toBeNull();
    expect(work.getByText("Showing 51–55 of 55")).toBeTruthy();
    expect(work.getByRole("button", { name: "Next page" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(work.getByRole("button", { name: "First page" }));
    expect(slot.getByText("issue 1")).toBeTruthy();
  });

  it("resets pages for searches, type filters, repositories, and page-size changes", async () => {
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: {
      ...handlers(),
      listItems: (input: unknown) => ({ items: githubRpcContract.listItems.input.parse(input).kind === "issue"
        ? Array.from({ length: 60 }, (_, index) => item(index + 1, "issue", "OPEN", index < 50 ? "acme/widgets" : "acme/other")) : [] }),
    } });
    await slot.findByText("issue 1");
    const work = () => within(slot.getByRole("navigation", { name: "Issues and pull requests pagination" }));
    fireEvent.click(work().getByRole("button", { name: "Last page" }));
    expect(slot.getByText("issue 51")).toBeTruthy();
    fireEvent.change(slot.getByRole("textbox", { name: "Search inbox" }), { target: { value: "issue 1" } });
    expect(slot.getByText("issue 1")).toBeTruthy();
    expect(slot.queryByText("issue 51")).toBeNull();
    fireEvent.change(slot.getByRole("textbox", { name: "Search inbox" }), { target: { value: "" } });
    expect(work().getByText("Page 1 of 3")).toBeTruthy();
    fireEvent.click(work().getByRole("button", { name: "Next page" }));
    fireEvent.click(slot.getByRole("button", { name: "Issues" }));
    const issues = () => within(slot.getByRole("navigation", { name: "Issues pagination" }));
    expect(issues().getByText("Page 1 of 3")).toBeTruthy();
    fireEvent.click(issues().getByRole("button", { name: "Next page" }));
    fireEvent.change(issues().getByRole("combobox", { name: "Issues per page" }), { target: { value: "50" } });
    expect(issues().getByText("Showing 1–50 of 60")).toBeTruthy();
    expect(slot.getByText("issue 50")).toBeTruthy();
    expect(slot.queryByText("issue 51")).toBeNull();
    fireEvent.click(issues().getByRole("button", { name: "Next page" }));
    fireEvent.change(slot.getByRole("combobox", { name: "Repository scope" }), { target: { value: "acme/widgets" } });
    await vi.waitFor(() => expect(issues().getByText("Showing 1–50 of 50")).toBeTruthy());
    expect(slot.getByText("issue 1")).toBeTruthy();
    expect(slot.queryByText("issue 51")).toBeNull();
  });

  it("keeps a valid page when a refresh removes the last page", async () => {
    let currentItems = Array.from({ length: 51 }, (_, index) => item(index + 1, "issue"));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: {
      ...handlers(),
      listItems: (input: unknown) => ({ items: githubRpcContract.listItems.input.parse(input).kind === "issue" ? currentItems : [] }),
    } });
    await slot.findByText("issue 1");
    const pages = within(slot.getByRole("navigation", { name: "Issues and pull requests pagination" }));
    fireEvent.click(pages.getByRole("button", { name: "Last page" }));
    expect(slot.getByText("issue 51")).toBeTruthy();
    currentItems = currentItems.slice(0, 10);
    await slot.behavior.emitRealtime("data-changed", {});
    await slot.findByText("issue 1");
    expect(slot.queryByText("issue 51")).toBeNull();
    expect(slot.queryByRole("navigation", { name: "Issues and pull requests pagination" })).toBeNull();
  });

  it("paginates pending approvals and Activity", async () => {
    const data = dashboard();
    data.jobs = Array.from({ length: 55 }, (_, index) => ({ ...job, id: index + 1, title: `Queued action ${index + 1}` }));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: { ...handlers(), automationDashboard: () => data, automationListJobs: (input: unknown) => jobPage(data, input) } });
    await slot.findByText("Job 1");
    expect(slot.queryByText("Job 26")).toBeNull();
    const approvals = within(slot.getByRole("navigation", { name: "Pending approvals pagination" }));
    fireEvent.click(approvals.getByRole("button", { name: "Next page" }));
    expect(slot.getByText("Job 26")).toBeTruthy();
    expect(slot.queryByText("Job 1")).toBeNull();
    slot.lifecycle.rerender(createElement(app.navPanels[0]!.component, { subPath: "activity" }));
    await slot.findByText("Job 1");
    const activity = within(slot.getByRole("navigation", { name: "Activity pagination" }));
    fireEvent.click(activity.getByRole("button", { name: "Last page" }));
    await slot.findByText("Job 55");
    expect(slot.queryByText("Job 1")).toBeNull();
  });

  it("keeps repository scope across navigation and filters automations and activity", async () => {
    const data = dashboard();
    data.rules = ["widgets", "other"].map((name, index) => ({
      id: name,
      name,
      enabled: false,
      order: index,
      events: ["issue.opened"],
      repos: [`acme/${name}`],
      filters: {},
      conditionGroups: [],
      actions: ["github.label"],
      actionParameters: { label: "triaged" },
      approvalRequired: true,
    }));
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      { rpc: { ...handlers(), automationDashboard: () => data, automationListJobs: (input: unknown) => jobPage(data, input) } },
    );
    await slot.findByText("issue 1");
    fireEvent.change(slot.getByRole("combobox", { name: "Repository scope" }), {
      target: { value: "acme/other" },
    });
    await vi.waitFor(() => expect(slot.queryByText("issue 1")).toBeNull());
    expect(slot.getByText("issue 3")).toBeTruthy();
    slot.lifecycle.rerender(
      createElement(app.navPanels[0]!.component, { subPath: "automation" }),
    );
    await slot.findByText("other", { selector: "p" });
    expect(slot.queryByText("widgets", { selector: "p" })).toBeNull();
    slot.lifecycle.rerender(
      createElement(app.navPanels[0]!.component, { subPath: "activity" }),
    );
    await slot.findByText("Agent conversations");
    expect(slot.queryByText("Job 7")).toBeNull();
    expect(localStorage.getItem("github-extended:repository")).toBe(
      "acme/other",
    );
  });

  it("keeps issues usable when security alerts fail", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: {
          ...handlers(),
          listDependabotAlerts: () => {
            throw new Error("offline");
          },
        },
      },
    );
    await slot.findByText("issue 1");
    expect(slot.getByRole("alert").textContent).toContain(
      "Security alerts could not load",
    );
    expect(slot.getByRole("button", { name: "Retry inbox" })).toBeTruthy();
  });

  it("approves a queued action from Inbox", async () => {
    const replay = vi.fn(() => ({ queued: true }));
    vi.spyOn(window, "confirm").mockReturnValueOnce(true);
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      { rpc: { ...handlers(), automationReplayJob: replay } },
    );
    fireEvent.click(
      await slot.findByRole("button", { name: "Approve and run" }),
    );
    await vi.waitFor(() =>
      expect(replay).toHaveBeenCalledWith({ jobId: 7, approve: true }),
    );
  });

  it("submits the native composer request with the user's task and opens its conversation", async () => {
    const spawn = vi.fn().mockResolvedValue({ id: "agent-created" });
    const slot = renderSlot(
      {
        component: () => (
          <AgentComposer
            context="Create a disabled GitHub automation."
            initialPrompt="Investigate new bug issues"
            projectId="widgets-project"
            draftKey="test-automation"
          />
        ),
      },
      {},
      { sdk: { threads: { spawn } } },
    );
    fireEvent.click(slot.getByTestId("bb-new-thread-composer-submit"));
    await vi.waitFor(() =>
      expect(spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "widgets-project",
          providerId: "codex",
          model: "gpt-5",
          reasoningLevel: "medium",
          permissionMode: "auto",
          executionInputSources: {},
          environment: { type: "project-default" },
          input: [
            {
              type: "text",
              text: "Create a disabled GitHub automation.",
              mentions: [],
            },
            { type: "text", text: "Investigate new bug issues", mentions: [] },
          ],
        }),
      ),
    );
    await act(async () => {});
    expect(
      slot.getByTestId("bb-thread-chat").getAttribute("data-thread-id"),
    ).toBe("agent-created");
  });

  it("prepares an item task in the attached project and a managed worktree before submission", async () => {
    const launcher = renderSlot({ component: () => <AskAgent repo="acme/widgets" number={4} kind="pr" /> }, {});
    fireEvent.click(launcher.getByRole("button", { name: "Ask agent" }));
    expect(launcher.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "github", options: { subPath: "agent/pr/acme/widgets/4" } });
    launcher.lifecycle.unmount();
    const spawn = vi.fn().mockResolvedValue({ id: "review-thread" });
    const link = vi.fn(() => ({ ok: true }));
    const slot = renderSlot(
      {
        component: () => (
          <AgentTaskView
            repo="acme/widgets"
            number={4}
            kind="pr"
            onBack={() => {}}
          />
        ),
      },
      {},
      {
        rpc: {
          agentTaskContext: () => ({
            projectId: "attached-project",
            hostId: "attached-host",
          }),
          linkItemToThread: link,
        },
        sdk: { threads: { spawn } },
      },
    );
    const composer = await slot.findByTestId("bb-new-thread-composer");
    expect(composer.getAttribute("data-default-project-id")).toBe(
      "attached-project",
    );
    expect(
      JSON.parse(composer.getAttribute("data-default-environment")!),
    ).toEqual({
      type: "host",
      hostId: "attached-host",
      workspace: { type: "managed-worktree", baseBranch: { kind: "default" } },
    });
    expect(composer.getAttribute("data-default-permission-mode")).toBe(
      "accept-edits",
    );
    fireEvent.click(slot.getByRole("button", { name: /^Fix$/ }));
    expect(slot.getByTestId("bb-new-thread-composer-input")).toHaveProperty(
      "value",
      "Fix pull request acme/widgets#4.",
    );
    fireEvent.click(slot.getByTestId("bb-new-thread-composer-submit"));
    await vi.waitFor(() =>
      expect(link).toHaveBeenCalledWith({
        threadId: "review-thread",
        repo: "acme/widgets",
        number: 4,
        kind: "pr",
      }),
    );
    expect(slot.navigateCalls).toContainEqual({
      method: "toThread",
      threadId: "review-thread",
    });
  });
});
