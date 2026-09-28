// @vitest-environment happy-dom
import { act, createElement, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { SessionMachineRouter } from "./SessionMachineRouter";
import {
  refreshRemoteMachines,
  rememberRemoteTab,
  remoteTabFor,
} from "../model/connections";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../../sessions/ui/AgentTranscript", () => ({
  AgentTranscript: () => null,
}));

let root: Root;
let container: HTMLDivElement;
let mounts: number;

function LocalPane({ machineControl }: { machineControl?: ReactNode }) {
  useEffect(() => {
    mounts++;
  }, []);
  return createElement("div", null, "Local pane", machineControl);
}

async function render(choosable: boolean) {
  await act(async () => {
    root.render(
      createElement(SessionMachineRouter, {
        cwd: "/laptop/repo",
        shellId: "shell",
        choosable,
        local: (machineControl) => createElement(LocalPane, { machineControl }),
      }),
    );
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  mounts = 0;
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue([]);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  localStorage.clear();
});

it("keeps the local pane mounted when its first message is sent", async () => {
  await render(true);
  expect(container.textContent).toContain("This computer");
  await render(false);
  expect(container.textContent).toContain("Local pane");
  expect(container.textContent).not.toContain("This computer");
  expect(mounts).toBe(1);
});

it("does not load machines for sessions that already started", async () => {
  await render(false);
  expect(invoke).not.toHaveBeenCalled();
});

it("reopens a tab's session after its machine is removed and added again", async () => {
  const removed = { id: "old", name: "Home server", environmentId: "env" };
  rememberRemoteTab("shell", removed as never, "remote-session");
  let machines: unknown[] = [];
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "remote_machines") return machines;
    throw "Machine is unreachable";
  });
  await render(true);
  expect(container.textContent).toContain(
    "This machine is no longer connected",
  );

  // Adding the same host again creates a new local machine ID.
  machines = [
    {
      id: "new",
      name: "Home server",
      endpoint: "ssh://me@home",
      environmentId: "env",
    },
  ];
  await act(async () => refreshRemoteMachines());
  expect(container.textContent).not.toContain("no longer connected");
  expect(container.textContent).toContain("Reconnecting");
  expect(remoteTabFor("shell")).toEqual({
    machineId: "new",
    environmentId: "env",
    sessionId: "remote-session",
  });
  expect(
    vi
      .mocked(invoke)
      .mock.calls.some(
        ([command, input]) =>
          command === "remote_request" &&
          (input as { machineId: string }).machineId === "new",
      ),
  ).toBe(true);
});
