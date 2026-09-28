// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RemoteChanges } from "./RemoteChanges";
import type { GitDiffIndex } from "../../../platform/tauri/fs";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn() }));

let container: HTMLDivElement;
let root: Root;
const empty: GitDiffIndex = {
  branch: null,
  head: null,
  files: [],
  additions: 0,
  deletions: 0,
  remote: null,
  upstream: null,
  defaultBranch: null,
  ahead: 0,
  behind: 0,
  aheadOfDefault: 0,
  headPushed: false,
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("uses the compact local Changes layout and one empty state", async () => {
  await act(async () =>
    root.render(
      createElement(RemoteChanges, {
        index: empty,
        error: "",
        refresh: () => {},
      }),
    ),
  );
  expect(container.querySelector("textarea")?.getAttribute("rows")).toBe("1");
  expect(
    container.querySelector('[aria-label="Commit options"]'),
  ).not.toBeNull();
  expect(container.textContent).toContain("No uncommitted changes");
  expect(container.textContent).not.toContain("CHANGES");
});

it("offers the connection update path without displaying a raw host error", async () => {
  await act(async () =>
    root.render(
      createElement(RemoteChanges, {
        index: null,
        error: "Host rejected request: Unsupported host method",
        refresh: () => {},
        machine: {
          id: "machine",
          name: "Host",
          environmentId: "env",
          endpoint: "ssh://host",
          ssh: { target: "host", remotePort: 3774 },
        },
      }),
    ),
  );
  expect(container.textContent).toContain("This machine needs a host update");
  expect(container.textContent).not.toContain("Unsupported host method");
  expect(container.textContent).toContain("Open connection settings");
});

it("only shows Create PR away from the default branch", async () => {
  const props = {
    index: {
      ...empty,
      branch: "master",
      defaultBranch: "master",
      remote: "origin",
      upstream: "origin/master",
    },
    error: "",
    refresh: () => {},
  };
  await act(async () => root.render(createElement(RemoteChanges, props)));
  expect(
    [...container.querySelectorAll("button")].some(
      (button) => button.textContent?.trim() === "Create PR",
    ),
  ).toBe(false);

  await act(async () =>
    root.render(
      createElement(RemoteChanges, {
        ...props,
        index: {
          ...props.index,
          branch: "feature/test",
          upstream: "origin/feature/test",
          aheadOfDefault: 1,
        },
      }),
    ),
  );
  const createPr = [...container.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === "Create PR",
  );
  expect(createPr).not.toBeUndefined();
  expect(createPr?.disabled).toBe(false);
});

it("opens a changed host file in the workspace with its diff side and pin state", async () => {
  const onOpenFile = vi.fn();
  await act(async () =>
    root.render(
      createElement(RemoteChanges, {
        project: {
          key: "remote://env/repo",
          environmentId: "env",
          projectId: "project",
          cwd: "/repo",
        },
        machine: {
          id: "machine",
          name: "Host",
          environmentId: "env",
          endpoint: "ssh://host",
        },
        cwd: "/repo/worktree",
        index: {
          ...empty,
          files: [
            {
              path: "/repo/worktree/README.md",
              relative: "README.md",
              status: "modified",
              additions: 1,
              deletions: 1,
              staged: true,
              unstaged: true,
            },
          ],
        },
        error: "",
        refresh: () => {},
        onOpenFile,
      }),
    ),
  );
  const buttons = [...container.querySelectorAll("button[title='README.md']")];
  expect(buttons).toHaveLength(2);
  await act(async () => buttons[0].click());
  expect(onOpenFile).toHaveBeenCalledWith({
    machineId: "machine",
    projectId: "project",
    projectKey: "remote://env/repo",
    cwd: "/repo/worktree",
    relativePath: "README.md",
    changeKind: "staged",
    pin: undefined,
  });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
