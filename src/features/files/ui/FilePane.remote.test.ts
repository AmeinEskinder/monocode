// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { newEditorPane, newFileTab } from "../../workspace/model/layout";
import { FilePane } from "./FilePane";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => []),
  isTauri: () => false,
  convertFileSrc: (path: string) => path,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("../../connections/ui/RemoteFileEditor", async () => {
  const React = await import("react");
  return {
    RemoteFileEditor: () =>
      React.createElement(
        "div",
        { "data-remote-editor": true },
        "Remote editor",
      ),
  };
});
vi.mock("./FileEditor", async () => {
  const React = await import("react");
  return {
    FileEditor: () =>
      React.createElement("div", { "data-local-editor": true }, "Local editor"),
  };
});

it("renders a host file in the normal pane without invoking the local editor", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const file = {
    ...newFileTab("/repo/src/index.ts", "/repo"),
    remoteFile: {
      machineId: "machine",
      projectId: "project",
      relativePath: "src/index.ts",
    },
  };
  const noop = () => {};
  const props: ComponentProps<typeof FilePane> = {
    pane: newEditorPane(file),
    focused: true,
    showTabs: false,
    dirtyFileIds: new Set(),
    fileErrorCounts: new Map(),
    sessions: [],
    onFocus: noop,
    onSelectFile: noop,
    onCloseFile: noop,
    onCloseOtherFiles: noop,
    onDirtyChange: noop,
    onErrorCountChange: noop,
    onReorderFiles: noop,
    onOpenFile: noop,
    onUpdatePlan: noop,
    onBuildPlan: noop,
  };
  await act(async () => root.render(createElement(FilePane, props)));
  expect(container.querySelector("[data-remote-editor]")).not.toBeNull();
  expect(container.querySelector("[data-local-editor]")).toBeNull();
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
