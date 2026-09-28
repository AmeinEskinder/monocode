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

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "remote_request" && args?.method === "files.list")
      return [
        {
          name: "index.ts",
          path: "src/index.ts",
          isDir: false,
          ignored: false,
        },
      ];
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
        rootLabel: "main",
        onOpenFile,
        searchOpen: false,
        onSearchClose: () => {},
      }),
    ),
  );
  const rootRow = container.querySelector('button[title="/repo"]');
  const row = container.querySelector<HTMLButtonElement>('[role="treeitem"]');
  expect(rootRow?.textContent).toContain("main");
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
