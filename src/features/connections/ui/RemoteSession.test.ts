// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  SessionPane,
  type SessionPaneProps,
} from "../../sessions/ui/SessionPane";
import type { Block, Session } from "../../sessions/model/session";
import type { AgentModel } from "../../sessions/model/models";
import { rememberRemoteProject } from "../model/remoteProjects";
import { rememberRemoteSession, remoteSessionFor } from "../model/connections";
import type {
  HostCommand,
  HostModelCatalog,
  HostSession,
  RemoteMachine,
} from "../model/protocol";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));
vi.mock("../../sessions/ui/AgentTranscript", () => ({
  AgentTranscript: ({
    blocks,
    busy,
    onSendDraft,
    onRemoveDraft,
  }: {
    blocks: Block[];
    busy: boolean;
    onSendDraft?: (block: Block) => void;
    onRemoveDraft?: (block: Block) => void;
  }) =>
    createElement(
      "ol",
      { "aria-label": "Transcript", "data-busy": busy },
      blocks.map((block) =>
        createElement(
          "li",
          { key: block.id },
          block.text,
          block.draft && onSendDraft
            ? createElement(
                "button",
                {
                  "aria-label": "Send remote draft",
                  onClick: () => onSendDraft(block),
                },
                "Send draft",
              )
            : null,
          block.draft && onRemoveDraft
            ? createElement(
                "button",
                {
                  "aria-label": "Remove remote draft",
                  onClick: () => onRemoveDraft(block),
                },
                "Remove draft",
              )
            : null,
        ),
      ),
    ),
}));

const machine: RemoteMachine = {
  id: "machine",
  name: "Home server",
  endpoint: "ssh://me@home",
  environmentId: "env",
};
const effort = (id: string, value: string) => ({
  id,
  label: "Reasoning",
  kind: "select" as const,
  value,
  options: ["low", "medium", "high"].map((option) => ({
    value: option,
    label: option[0].toUpperCase() + option.slice(1),
  })),
});
const gpt: AgentModel = {
  id: "codex:gpt-test",
  harness: "codex",
  name: "GPT Test",
  nativeId: "gpt-test",
  settings: [effort("reasoningEffort", "medium")],
};

let root: Root;
let container: HTMLDivElement;
let host: HostSession | undefined;
let catalog: HostModelCatalog | Error;
let commands: HostCommand[];
let projectKey: string;
let syncDelay: Promise<void> | undefined;
let branchFailure: string | undefined;
let branchActionFailure: string | undefined;
let currentBranch: string;
let createdBranch: string | undefined;
let createdWorktree: string | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  localStorage.setItem("monocode.modelControls", "beside");
  commands = [];
  host = undefined;
  syncDelay = undefined;
  branchFailure = undefined;
  branchActionFailure = undefined;
  currentBranch = "main";
  createdBranch = undefined;
  createdWorktree = undefined;
  catalog = { models: { codex: [gpt] }, errors: {} };
  projectKey = rememberRemoteProject("env", {
    id: "project",
    name: "repo",
    cwd: "/home/me/repo",
  }).key;
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command, input) => {
    if (command === "remote_machines") return [machine];
    if (command !== "remote_request") return undefined;
    const { method, params } = input as {
      method: string;
      params: HostCommand & { sessionId?: string };
    };
    if (method === "environment.describe")
      return {
        protocolVersion: 1,
        environmentId: "env",
        name: "home",
        providers: ["codex"],
        capabilities: ["attachments.upload", "sessions.plan", "sessions.draft"],
      };
    if (method === "models.list") {
      if (catalog instanceof Error) throw catalog.message;
      return catalog;
    }
    if (method === "git.branches") {
      if (branchFailure) throw new Error(branchFailure);
      return {
        current: currentBranch,
        branches: ["main", "dev", ...(createdBranch ? [createdBranch] : [])],
      };
    }
    if (method === "git.worktrees")
      return {
        defaultRoot: "/home/me/repo-worktrees",
        worktrees: [
          {
            path: "/home/me/repo",
            branch: "main",
            head: "abc",
            isMain: true,
            missing: false,
          },
          {
            path: "/home/me/repo-worktrees/dev",
            branch: "dev",
            head: "def",
            isMain: false,
            missing: false,
          },
          ...(createdWorktree
            ? [
                {
                  path: createdWorktree,
                  branch: createdBranch,
                  head: "abc",
                  isMain: false,
                  missing: false,
                },
              ]
            : []),
        ],
      };
    if (method === "git.worktreeCreate") {
      createdBranch = params.branch;
      createdWorktree = `/home/me/repo-worktrees/wt-${params.branch.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
      return {
        path: createdWorktree,
        branch: createdBranch,
        head: "abc",
        isMain: false,
        missing: false,
      };
    }
    if (method === "git.switch" || method === "git.createBranch") {
      if (branchActionFailure) throw new Error(branchActionFailure);
      currentBranch = params.branch;
      if (method === "git.createBranch") createdBranch = params.branch;
      return {
        current: params.branch,
        branches: ["main", "dev", ...(createdBranch ? [createdBranch] : [])],
      };
    }
    if (method === "sessions.sync") {
      if (syncDelay) await syncDelay;
      return { kind: "snapshot", value: host };
    }
    if (method === "attachments.upload")
      return { offset: (params as { size: number }).size };
    if (method === "commands.dispatch") return dispatch(params);
    throw new Error(`Unexpected method ${method}`);
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  localStorage.clear();
});

/** A minimal host engine: persists commands the way the real one does. */
function dispatch(command: HostCommand) {
  commands.push(command);
  if (command.type === "create") {
    host = {
      projectId: command.projectId,
      revision: 1,
      status: "idle",
      updatedAt: 0,
      session: {
        id: "host-session",
        cwd: command.worktreeCwd ?? "/home/me/repo",
        harness: command.harness,
        model: command.model,
        modelSettings: command.modelSettings ?? {},
        runtimeMode: command.runtimeMode,
        title: "New remote session",
        blocks: [],
      },
    };
  } else if (host && command.type === "configure") {
    host = {
      ...host,
      revision: host.revision + 1,
      session: {
        ...host.session,
        model: command.model,
        modelSettings: command.modelSettings,
        runtimeMode: command.runtimeMode,
      },
    };
  } else if (host && command.type === "send") {
    host = {
      ...host,
      revision: host.revision + 1,
      status: "idle",
      session: {
        ...host.session,
        blocks: [
          ...host.session.blocks.filter(
            (block) => block.id !== command.draftBlockId,
          ),
          { id: command.commandId, role: "user", text: command.text },
          { id: `${command.commandId}-reply`, role: "assistant", text: "Done" },
        ],
      },
    };
  } else if (host && command.type === "draft") {
    host = {
      ...host,
      revision: host.revision + 1,
      session: {
        ...host.session,
        blocks: [
          ...host.session.blocks,
          {
            id: command.commandId,
            role: "user",
            text: command.text,
            draft: true,
          },
        ],
      },
    };
  } else if (host && command.type === "removeDraft") {
    host = {
      ...host,
      revision: host.revision + 1,
      session: {
        ...host.session,
        blocks: host.session.blocks.filter(
          (block) => block.id !== command.draftBlockId,
        ),
      },
    };
  }
  return {
    commandId: command.commandId,
    sessionId: "host-session",
    revision: host?.revision ?? 1,
  };
}

const shell = (): Session => ({
  id: "shell",
  cwd: projectKey,
  harness: "claude",
  model: "claude:sonnet-5",
  modelSettings: { reasoningEffort: "high" },
  runtimeMode: "supervised",
  title: "New session",
  blocks: [],
});

async function render(
  session = shell(),
  extra: Partial<SessionPaneProps> = {},
) {
  const props = {
    session,
    visible: true,
    focused: true,
    inSplit: false,
    composerFocused: false,
    recents: [],
    onFocus: vi.fn(),
    onClose: vi.fn(),
    ...extra,
  } as unknown as SessionPaneProps;
  await act(async () => root.render(createElement(SessionPane, props)));
  await settle();
}
async function settle() {
  for (let i = 0; i < 5; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
}
const byLabel = (prefix: string) =>
  container.querySelector<HTMLButtonElement>(`button[aria-label^="${prefix}"]`);
async function type(text: string) {
  const textarea = container.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function send(text: string) {
  await type(text);
  await act(async () => byLabel("Send")!.click());
  await settle();
}
async function chooseEffort(label: string) {
  await act(async () => byLabel("Reasoning:")!.click());
  const option = [
    ...document.body.querySelectorAll<HTMLButtonElement>(
      '[role="menuitemradio"]',
    ),
  ].find((item) => item.textContent?.includes(label))!;
  await act(async () => option.click());
  await settle();
}

it("uses the normal composer with the machine and host branch in its top row", async () => {
  await render();
  expect(container.querySelector("textarea")).not.toBeNull();
  expect(container.textContent).toContain("Home server");
  expect(byLabel("Host branch main")).not.toBeNull();
  expect(
    [...container.querySelectorAll("button")].some(
      (button) => button.textContent === "Changes",
    ),
  ).toBe(false);
  // The host's model, keeping the tab's effort where the model supports it.
  expect(byLabel("Reasoning:")?.getAttribute("aria-label")).toBe(
    "Reasoning: High",
  );
  expect(container.textContent).toContain("GPT Test");
  // Nothing from the old standalone remote view or local-only tools.
  expect(container.textContent).not.toContain("New remote session");
  expect(container.textContent).not.toContain("Apply settings");
  expect(byLabel("Add files or choose a mode")?.closest(".hidden")).toBeNull();
  await act(async () => byLabel("Add files or choose a mode")!.click());
  expect(document.body.textContent).toContain("Upload file");
  expect(document.body.textContent).toContain("Plan mode");
  expect(document.body.textContent).toContain("Draft");
  expect(document.body.textContent).not.toContain("Operator");
  expect(byLabel("Project ")).toBeNull();
});

it("opens a host conversation in an already mounted empty tab", async () => {
  await render();
  dispatch({
    type: "create",
    commandId: "existing-session",
    projectId: "project",
    harness: "codex",
    model: gpt.id,
    runtimeMode: "supervised",
  });
  host = {
    ...host!,
    session: {
      ...host!.session,
      title: "Codex · Existing conversation",
      blocks: [{ id: "old-message", role: "user", text: "Earlier message" }],
    },
  };
  commands = [];
  await act(async () => rememberRemoteSession("shell", "host-session"));
  await settle();
  expect(container.textContent).toContain("Earlier message");
  await send("Continue here");
  expect(commands.some((command) => command.type === "create")).toBe(false);
  expect(commands.some((command) => command.type === "send")).toBe(true);
});

it("keeps an unopened remote conversation docked while its transcript loads", async () => {
  dispatch({
    type: "create",
    commandId: "existing-session",
    projectId: "project",
    harness: "codex",
    model: gpt.id,
    runtimeMode: "supervised",
  });
  host = {
    ...host!,
    session: {
      ...host!.session,
      id: "unopened-session",
      blocks: [{ id: "old-message", role: "user", text: "Earlier message" }],
    },
  };
  rememberRemoteSession("shell", "unopened-session");
  let releaseSync = () => {};
  syncDelay = new Promise<void>((resolve) => {
    releaseSync = resolve;
  });

  await render();
  const composer = container.querySelector("[data-session-composer]");
  expect(composer?.classList.contains("max-w-4xl")).toBe(true);
  expect(container.textContent).not.toContain("Loading conversation…");
  expect(container.textContent).not.toContain("What should we work on?");

  await act(async () => {
    releaseSync();
    syncDelay = undefined;
  });
  await settle();
  expect(container.textContent).toContain("Earlier message");
  expect(container.querySelector("[data-session-composer]")).toBe(composer);
});

it("keeps the branch picker visible when Git lookup fails and offers a retry", async () => {
  branchFailure = "fatal: not a git repository";
  await render();
  const picker = byLabel("Host branch No repo");
  expect(picker).not.toBeNull();
  await act(async () => picker!.click());
  expect(document.body.textContent).toContain("not a git repository");
  branchFailure = undefined;
  const retry = [
    ...document.body.querySelectorAll<HTMLButtonElement>("button"),
  ].find((button) => button.textContent === "Retry");
  await act(async () => retry!.click());
  await settle();
  expect(byLabel("Host branch main")).not.toBeNull();
});

it("creates the host session with the chosen settings on the first message", async () => {
  await render();
  await chooseEffort("Medium");
  expect(commands).toHaveLength(0);
  await send("Fix the tests");
  expect(commands.map((command) => command.type)).toEqual(["create", "send"]);
  expect(commands[0]).toMatchObject({
    projectId: "project",
    harness: "codex",
    model: "codex:gpt-test",
    modelSettings: { reasoningEffort: "medium" },
  });
  expect(commands[1]).toMatchObject({
    sessionId: "host-session",
    text: "Fix the tests",
  });
  expect(remoteSessionFor("shell")).toBe("host-session");
  expect(container.textContent).toContain("Fix the tests");
});

it("sends a remote plan turn from the plus menu", async () => {
  await render();
  await act(async () => byLabel("Add files or choose a mode")!.click());
  const plan = [
    ...document.body.querySelectorAll<HTMLButtonElement>("button"),
  ].find((button) => button.textContent?.includes("Plan mode"))!;
  await act(async () => plan.click());
  await send("Plan the migration");
  expect(commands.at(-1)).toMatchObject({
    type: "send",
    text: "Plan the migration",
    intent: "plan",
  });
});

it("saves and sends a remote draft", async () => {
  await render();
  await act(async () => byLabel("Add files or choose a mode")!.click());
  const draft = [
    ...document.body.querySelectorAll<HTMLButtonElement>("button"),
  ].find((button) =>
    button.textContent?.includes("Save this message without starting"),
  )!;
  await act(async () => draft.click());
  await type("Review this later");
  await act(async () => byLabel("Save draft")!.click());
  await settle();
  expect(commands.map((command) => command.type)).toEqual(["create", "draft"]);
  expect(commands.at(-1)).toMatchObject({
    type: "draft",
    text: "Review this later",
  });
  expect(byLabel("Send remote draft")).not.toBeNull();
  await act(async () => byLabel("Send remote draft")!.click());
  await settle();
  expect(commands.at(-1)).toMatchObject({
    type: "send",
    text: "Review this later",
    draftBlockId: commands[1].commandId,
  });
});

it("keeps a sent message visible until the host sync confirms it", async () => {
  await render();
  await send("First");
  let releaseSync = () => {};
  syncDelay = new Promise<void>((resolve) => {
    releaseSync = resolve;
  });
  await type("Second");
  await act(async () => byLabel("Send")!.click());
  expect(commands.at(-1)).toMatchObject({ type: "send", text: "Second" });
  const secondMessages = () =>
    [...container.querySelectorAll("ol[aria-label='Transcript'] li")].filter(
      (item) => item.textContent === "Second",
    );
  expect(secondMessages()).toHaveLength(1);
  expect(
    container
      .querySelector("ol[aria-label='Transcript']")
      ?.getAttribute("data-busy"),
  ).toBe("true");
  await act(async () => {
    releaseSync();
    syncDelay = undefined;
  });
  await settle();
  expect(secondMessages()).toHaveLength(1);
});

it("keeps the first turn active while its accepted message awaits host sync", async () => {
  await render();
  let releaseSync = () => {};
  syncDelay = new Promise<void>((resolve) => {
    releaseSync = resolve;
  });
  await send("First remote turn");
  expect(commands.map((command) => command.type)).toEqual(["create", "send"]);
  const transcript = () =>
    container.querySelector("ol[aria-label='Transcript']");
  expect(transcript()?.textContent).toContain("First remote turn");
  expect(transcript()?.getAttribute("data-busy")).toBe("true");
  await act(async () => {
    releaseSync();
    syncDelay = undefined;
  });
  await settle();
  expect(transcript()?.querySelectorAll("li")).toHaveLength(2);
  expect(transcript()?.getAttribute("data-busy")).toBe("false");
});

it("starts a remote session in the worktree chosen before its first message", async () => {
  await render();
  await act(async () => byLabel("Workspace Current checkout")!.click());
  const existing = [
    ...document.body.querySelectorAll<HTMLButtonElement>("button"),
  ].find((button) => button.textContent?.trim() === "Existing worktree…");
  await act(async () => existing!.click());
  await settle();
  const worktree = [
    ...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
  ].find((button) => button.title === "/home/me/repo-worktrees/dev");
  expect(worktree).toBeDefined();
  await act(async () => worktree!.click());
  await send("Work in dev");
  expect(commands[0]).toMatchObject({
    type: "create",
    worktreeCwd: "/home/me/repo-worktrees/dev",
  });
  expect(host?.session.cwd).toBe("/home/me/repo-worktrees/dev");
});

it("creates a host worktree through the composer and selects it", async () => {
  await render();
  await act(async () => byLabel("Workspace Current checkout")!.click());
  expect(
    document.body.querySelector('[aria-label="Workspace"]'),
  ).not.toBeNull();
  expect(document.body.textContent).toContain("Existing worktree…");
  expect(document.body.textContent).toContain("Worktree settings");
  expect(
    document.body.querySelector('[aria-label="Existing worktrees"]'),
  ).toBeNull();
  expect(
    document.body.querySelector('input[placeholder="Search working copies…"]'),
  ).toBeNull();
  const create = [
    ...document.body.querySelectorAll<HTMLButtonElement>("button"),
  ].find((button) => button.textContent?.trim() === "New worktree");
  await act(async () => create!.click());
  expect(byLabel("Workspace New worktree")).not.toBeNull();
  expect(byLabel("Create worktree from main")).not.toBeNull();
  expect(byLabel("Host branch main")).toBeNull();
  await act(async () => byLabel("Create worktree from main")!.click());
  const devBase = [
    ...document.body.querySelectorAll<HTMLButtonElement>('[role="option"]'),
  ].find((button) => button.textContent?.trim() === "dev");
  await act(async () => devBase!.click());
  expect(byLabel("Create worktree from dev")).not.toBeNull();
  expect(invoke).not.toHaveBeenCalledWith(
    "remote_request",
    expect.objectContaining({ method: "git.worktreeCreate" }),
  );
  await send("Work in new tree");
  expect(invoke).toHaveBeenCalledWith(
    "remote_request",
    expect.objectContaining({
      method: "git.worktreeCreate",
      params: expect.objectContaining({
        projectId: "project",
        cwd: "/home/me/repo",
        branch: expect.stringMatching(/^mc\/[a-z0-9]+$/),
        base: "dev",
        existing: false,
      }),
    }),
  );
  expect(commands[0]).toMatchObject({
    type: "create",
    worktreeCwd: createdWorktree,
    autoWorktreeBranch: createdBranch,
  });
});

it("searches and creates a host branch from the composer picker", async () => {
  await render();
  await act(async () => byLabel("Host branch main")!.click());
  const search = document.body.querySelector<HTMLInputElement>(
    'input[aria-label="Search or create a host branch"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(search, "feature/test");
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const create = [
    ...document.body.querySelectorAll<HTMLButtonElement>("button"),
  ].find((button) =>
    button.textContent?.includes("Create and checkout feature/test"),
  );
  await act(async () => create!.click());
  await settle();
  expect(invoke).toHaveBeenCalledWith(
    "remote_request",
    expect.objectContaining({
      method: "git.createBranch",
      params: expect.objectContaining({
        branch: "feature/test",
        cwd: "/home/me/repo",
      }),
    }),
  );
  expect(byLabel("Host branch feature/test")).not.toBeNull();
});

it("keeps a failed host branch action in the picker", async () => {
  branchActionFailure =
    "Commit or stash changes on the host before switching branches";
  await render();
  await act(async () => byLabel("Host branch main")!.click());
  const dev = [
    ...document.body.querySelectorAll<HTMLButtonElement>('[role="option"]'),
  ].find((button) => button.textContent?.includes("dev"));
  await act(async () => dev!.click());
  await settle();
  expect(
    document.body.querySelector('[aria-label="Host branches"]'),
  ).not.toBeNull();
  expect(document.body.textContent).toContain(branchActionFailure);
});

it("opens another tab when a started session selects a different worktree", async () => {
  host = {
    projectId: "project",
    revision: 1,
    status: "idle",
    updatedAt: 0,
    session: {
      id: "host-session",
      cwd: "/home/me/repo",
      harness: "codex",
      model: "codex:gpt-test",
      modelSettings: {},
      runtimeMode: "supervised",
      title: "Existing conversation",
      blocks: [{ id: "first", role: "user", text: "Earlier work" }],
    },
  };
  rememberRemoteSession("shell", "host-session");
  const onOpenRemoteWorktree = vi.fn();
  await render(shell(), { onOpenRemoteWorktree });
  await act(async () => byLabel("Workspace Current checkout")!.click());
  const existing = [
    ...document.body.querySelectorAll<HTMLButtonElement>("button"),
  ].find((button) => button.textContent?.trim() === "Existing worktree…");
  await act(async () => existing!.click());
  await settle();
  const worktree = [
    ...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
  ].find((button) => button.title === "/home/me/repo-worktrees/dev");
  await act(async () => worktree!.click());
  expect(onOpenRemoteWorktree).toHaveBeenCalledWith(
    projectKey,
    "/home/me/repo-worktrees/dev",
    expect.objectContaining({ model: "codex:gpt-test" }),
  );
  expect(commands).toHaveLength(0);
});

it("applies effort changes directly and uses them on the next turn", async () => {
  await render();
  await send("First");
  await chooseEffort("Low");
  expect(commands.at(-1)).toMatchObject({
    type: "configure",
    model: "codex:gpt-test",
    modelSettings: { reasoningEffort: "low" },
  });
  expect(host?.session.modelSettings).toEqual({ reasoningEffort: "low" });
  await settle();
  expect(
    commands.filter((command) => command.type === "configure"),
  ).toHaveLength(1);
  await send("Second");
  expect(commands.at(-1)).toMatchObject({ type: "send", text: "Second" });

  // Reopening the tab shows the saved setting.
  await act(async () => root.unmount());
  root = createRoot(container);
  await render();
  expect(byLabel("Reasoning:")?.getAttribute("aria-label")).toBe(
    "Reasoning: Low",
  );
});

it("keeps a saved model's effort editable when the host catalog fails", async () => {
  await render();
  await send("First");
  catalog = new Error("Codex CLI is not authenticated");
  await act(async () => root.unmount());
  root = createRoot(container);
  await render();
  expect(container.textContent).toContain("Couldn’t load models");
  expect(byLabel("Reasoning:")?.getAttribute("aria-label")).toBe(
    "Reasoning: High",
  );
  await chooseEffort("Low");
  expect(commands.at(-1)).toMatchObject({
    type: "configure",
    model: "codex:gpt-test",
    modelSettings: { reasoningEffort: "low" },
  });
});

it("asks to connect the machine when it is not set up on this computer", async () => {
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "remote_machines" ? [] : undefined,
  );
  await render();
  expect(container.textContent).toContain(
    "The machine for this project isn’t connected on this computer.",
  );
  expect(container.querySelector("textarea")).toBeNull();
});

it("holds a settings change during a running turn and applies it afterwards", async () => {
  await render();
  await send("First");
  host = {
    ...host!,
    revision: host!.revision + 1,
    status: "running",
    runId: "run",
    session: { ...host!.session, busy: true },
  };
  await vi.waitFor(() => expect(byLabel("Stop")).not.toBeNull(), {
    timeout: 4_000,
  });
  await chooseEffort("Low");
  expect(commands.some((command) => command.type === "configure")).toBe(false);

  await act(async () => byLabel("Stop")!.click());
  expect(commands.at(-1)).toMatchObject({ type: "cancel", runId: "run" });

  host = {
    ...host!,
    revision: host!.revision + 1,
    status: "idle",
    runId: undefined,
    session: { ...host!.session, busy: false },
  };
  await vi.waitFor(
    () =>
      expect(commands.at(-1)).toMatchObject({
        type: "configure",
        modelSettings: { reasoningEffort: "low" },
      }),
    { timeout: 4_000 },
  );
});
