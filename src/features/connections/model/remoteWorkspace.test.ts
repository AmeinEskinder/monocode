// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { GitDiffIndex } from "../../../platform/tauri/fs";
import { useRemoteWorkspace } from "./remoteWorkspace";

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  machines: vi.fn(),
  project: vi.fn(),
}));
vi.mock("./connections", () => ({
  remoteRequest: mocks.request,
  useRemoteMachines: mocks.machines,
}));
vi.mock("./remoteProjects", () => ({ remoteProjectFor: mocks.project }));

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
afterEach(() => {
  if (root) act(() => root.unmount());
  container?.remove();
  vi.unstubAllGlobals();
  mocks.request.mockReset();
});

function Probe({ executionCwd }: { executionCwd?: string }) {
  const { index } = useRemoteWorkspace("remote://env/repo", executionCwd, true);
  return createElement("span", null, index?.branch ?? "none");
}

it("keeps the branch when a file tab resolves the same remote folder", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.project.mockReturnValue({
    key: "remote://env/repo",
    environmentId: "env",
    projectId: "project",
    cwd: "/repo",
  });
  mocks.machines.mockReturnValue({
    machines: [{ id: "machine", environmentId: "env" }],
    loaded: true,
  });
  let complete!: (value: GitDiffIndex) => void;
  mocks.request.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(Probe, {})));
  expect(container.textContent).toBe("none");
  await act(async () => complete({ branch: "master" } as GitDiffIndex));
  expect(container.textContent).toBe("master");
  await act(async () =>
    root.render(createElement(Probe, { executionCwd: "/repo" })),
  );
  expect(container.textContent).toBe("master");
  expect(mocks.request).toHaveBeenCalledTimes(1);
});
