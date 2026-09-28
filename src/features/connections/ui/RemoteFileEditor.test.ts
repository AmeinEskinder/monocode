// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { RemoteFileEditor } from "./RemoteFileEditor";
import type { FilePaneTab } from "../../workspace/model/layout";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../../files/ui/FileEditor", async () => {
  const React = await import("react");
  return {
    CodeMirrorEditor: ({
      value,
      onSave,
      showDiff,
      gitOriginal,
    }: {
      value: string;
      onSave: (value: string) => Promise<void>;
      showDiff: boolean;
      gitOriginal: string | null;
    }) =>
      React.createElement(
        "button",
        {
          onClick: () => void onSave("edited\n"),
          "data-show-diff": showDiff,
          "data-original": gitOriginal,
        },
        value,
      ),
  };
});

it("loads a host diff into the workspace editor review", async () => {
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command !== "remote_request")
      throw new Error(`Unexpected command ${command}`);
    if (args?.method === "files.read") return "changed\n";
    if (args?.method === "git.fileDiff")
      return {
        original: "original\n",
        current: "changed\n",
        binary: false,
        tooLarge: false,
      };
    throw new Error(`Unexpected method ${args?.method}`);
  });
  await act(async () =>
    root.render(
      createElement(RemoteFileEditor, {
        file: { ...file, review: true, changeKind: "staged" },
        active: true,
        onDirtyChange: () => {},
        onErrorCountChange: () => {},
      }),
    ),
  );
  const editor = container.querySelector("button")!;
  expect(editor.dataset.showDiff).toBe("true");
  expect(editor.dataset.original).toBe("original\n");
  expect(invoke).toHaveBeenCalledWith("remote_request", {
    machineId: "machine",
    method: "git.fileDiff",
    params: {
      projectId: "project",
      cwd: "/repo",
      path: "src/index.ts",
      staged: true,
    },
  });
});

const file: FilePaneTab & {
  remoteFile: NonNullable<FilePaneTab["remoteFile"]>;
} = {
  id: "file",
  path: "/repo/src/index.ts",
  cwd: "/repo",
  remoteFile: {
    machineId: "machine",
    projectId: "project",
    relativePath: "src/index.ts",
  },
};
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command !== "remote_request")
      throw new Error(`Unexpected command ${command}`);
    if (args?.method === "files.read") return "original\n";
    if (args?.method === "files.write") return null;
    throw new Error(`Unexpected method ${args?.method}`);
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

it("loads and saves the host file through RPC in the regular editor surface", async () => {
  await act(async () =>
    root.render(
      createElement(RemoteFileEditor, {
        file,
        active: true,
        onDirtyChange: () => {},
        onErrorCountChange: () => {},
      }),
    ),
  );
  expect(container.querySelector("button")?.textContent).toBe("original\n");
  await act(async () => container.querySelector("button")!.click());
  expect(invoke).toHaveBeenCalledWith("remote_request", {
    machineId: "machine",
    method: "files.write",
    params: {
      projectId: "project",
      cwd: "/repo",
      path: "src/index.ts",
      expected: "original\n",
      content: "edited\n",
    },
  });
  expect(container.textContent).toContain("Saved");
});
