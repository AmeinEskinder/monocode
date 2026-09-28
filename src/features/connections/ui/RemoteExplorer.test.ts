// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { RemoteExplorer } from "./RemoteExplorer";
import type { RemoteProject } from "../model/remoteProjects";
import type { RemoteMachine } from "../model/protocol";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const project: RemoteProject = {
  key: "remote://env/repo",
  environmentId: "env",
  projectId: "project",
  cwd: "/repo",
};
const machine: RemoteMachine = {
  id: "machine",
  name: "Host",
  environmentId: "env",
  endpoint: "ssh://host",
  ssh: { target: "host", remotePort: 3774 },
};
let container: HTMLDivElement;
let root: Root;
let entries: { name: string; path: string; isDir: boolean; ignored: boolean }[];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(invoke).mockReset();
  entries = [
    {
      name: "index.ts",
      path: "src/index.ts",
      isDir: false,
      ignored: false,
    },
  ];
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "remote_request" && args?.method === "files.list")
      return entries;
    if (command === "remote_request" && args?.method === "files.create") {
      const params = args?.params as {
        name: string;
        parent: string;
        isDir: boolean;
      };
      const path = [params.parent, params.name].filter(Boolean).join("/");
      entries = [
        ...entries,
        { name: params.name, path, isDir: params.isDir, ignored: false },
      ];
      return path;
    }
    throw new Error(`Unexpected command ${command}`);
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("uses local Explorer row sizing and opens a file in the editor callback", async () => {
  const onOpenFile = vi.fn();
  await act(async () =>
    root.render(
      createElement(RemoteExplorer, {
        project,
        machine,
        cwd: "/repo",
        enabled: true,
        statuses: new Map(),
        onOpenFile,
      }),
    ),
  );
  const rootRow = container.querySelector('button[title="/repo"]');
  const row = container.querySelector<HTMLButtonElement>('[role="treeitem"]');
  expect(rootRow?.textContent).toContain("repo");
  expect(rootRow?.lastElementChild?.className).toContain("uppercase");
  expect(row?.className).toContain("text-[14px]");
  expect(row?.className).toContain("h-7.5");
  await act(async () => row!.click());
  expect(onOpenFile).toHaveBeenCalledWith({
    machineId: "machine",
    projectId: "project",
    projectKey: project.key,
    cwd: "/repo",
    relativePath: "src/index.ts",
  });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("keeps the tree mounted when a file tab supplies the same host folder", async () => {
  const props = {
    project,
    machine,
    enabled: true,
    statuses: new Map<string, string>(),
  };
  await act(async () => root.render(createElement(RemoteExplorer, props)));
  const row = container.querySelector('[role="treeitem"]');
  await act(async () =>
    root.render(createElement(RemoteExplorer, { ...props, cwd: "/repo" })),
  );
  expect(container.querySelector('[role="treeitem"]')).toBe(row);
  expect(
    container.querySelector('button[title="/repo"]')?.textContent,
  ).toContain("repo");
});

it("uses the local creation controls and creates a remote folder inline", async () => {
  await act(async () =>
    root.render(
      createElement(RemoteExplorer, {
        project,
        machine,
        enabled: true,
        statuses: new Map(),
      }),
    ),
  );
  expect(container.querySelector('[aria-label="New File"]')).not.toBeNull();
  await act(async () =>
    (
      container.querySelector('[aria-label="New Folder"]') as HTMLButtonElement
    ).click(),
  );
  const input = container.querySelector<HTMLInputElement>(
    'input[aria-label^="Type file name"]',
  )!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(input, "assets");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () =>
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    ),
  );
  expect(invoke).toHaveBeenCalledWith(
    "remote_request",
    expect.objectContaining({
      method: "files.create",
      params: expect.objectContaining({
        parent: "",
        name: "assets",
        isDir: true,
      }),
    }),
  );
  expect(
    container.querySelector('[role="treeitem"][title="assets"]'),
  ).not.toBeNull();
});

it("opens the full search panel from the Explorer toolbar", async () => {
  const onSearchOpen = vi.fn();
  await act(async () =>
    root.render(
      createElement(RemoteExplorer, {
        project,
        machine,
        enabled: true,
        statuses: new Map(),
        onSearchOpen,
      }),
    ),
  );
  await act(async () =>
    (
      container.querySelector(
        '[aria-label="Search in files"]',
      ) as HTMLButtonElement
    ).click(),
  );
  expect(onSearchOpen).toHaveBeenCalledOnce();
  expect(container.querySelector('[aria-label="Find remote file"]')).toBeNull();
});
