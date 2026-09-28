// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { RemoteSessionPane } from "./RemoteSessionPane";
import { rememberSession, rememberWorkspace } from "../model/connections";
import type {
  HostCommand,
  HostModelCatalog,
  HostSession,
  RemoteMachine,
} from "../model/protocol";
import type { AgentModel } from "../../sessions/model/models";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../../sessions/ui/AgentTranscript", () => ({
  AgentTranscript: () => createElement("div", null, "Host transcript"),
}));

const machine: RemoteMachine = {
  id: "machine",
  name: "Home server",
  endpoint: "http://127.0.0.1:3774",
  environmentId: "env",
};
const efforts = (id: string, values: string[], value = "medium") => ({
  id,
  label: "Reasoning",
  kind: "select" as const,
  value,
  options: values.map((option) => ({
    value: option,
    label: option[0].toUpperCase() + option.slice(1),
  })),
});
const codexModel: AgentModel = {
  id: "codex:gpt-test",
  harness: "codex",
  name: "GPT Test",
  nativeId: "gpt-test",
  settings: [efforts("reasoningEffort", ["low", "medium", "high"])],
};
const claudeModel: AgentModel = {
  id: "claude:opus-4-6",
  harness: "claude",
  name: "Claude Opus 4.6",
  nativeId: "claude-opus-4-6",
  settings: [efforts("effort", ["low", "medium", "high", "max"], "high")],
};

let root: Root;
let container: HTMLDivElement;
let host: HostSession;
let catalog: HostModelCatalog | Error;
let offline: boolean;
let commands: HostCommand[];
let catalogRequests: number;

function session(
  harness: "codex" | "claude",
  model: string,
  modelSettings: Record<string, string>,
): HostSession {
  return {
    projectId: "project",
    revision: 1,
    status: "idle",
    updatedAt: 0,
    session: {
      id: "session",
      harness,
      model,
      modelSettings,
      runtimeMode: "supervised",
      cwd: "/host/repo",
      title: "Host session",
      blocks: [],
    },
  };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  commands = [];
  catalogRequests = 0;
  offline = false;
  catalog = {
    models: { codex: [codexModel], claude: [claudeModel] },
    errors: {},
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  rememberWorkspace("/laptop/repo", "env", {
    id: "project",
    name: "Repo",
    cwd: "/host/repo",
  });
  rememberSession("/laptop/repo", "env", "session");
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (_command, input) => {
    const { method, params } = input as { method: string; params: HostCommand };
    if (offline) throw "Machine is unreachable";
    if (method === "environment.describe")
      return {
        protocolVersion: 1,
        environmentId: "env",
        providers: ["codex", "claude"],
        capabilities: ["sessions"],
      };
    if (method === "models.list") {
      catalogRequests++;
      if (catalog instanceof Error) throw catalog.message;
      return catalog;
    }
    if (method === "sessions.list") return [];
    if (method === "sessions.sync") return { kind: "snapshot", value: host };
    if (method === "commands.dispatch") {
      commands.push(params);
      // Mirror the host engine: configure persists on the session.
      if (params.type === "configure")
        host = {
          ...host,
          revision: host.revision + 1,
          session: {
            ...host.session,
            model: params.model,
            modelSettings: params.modelSettings,
            runtimeMode: params.runtimeMode,
          },
        };
      return {
        commandId: params.commandId,
        sessionId: "session",
        revision: host.revision,
      };
    }
    throw new Error(`Unexpected method ${method}`);
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

async function render() {
  await act(async () => {
    root.render(
      createElement(RemoteSessionPane, {
        machine,
        project: "/laptop/repo",
        shellId: "shell",
        machinePicker: "Machine picker",
      }),
    );
  });
}
async function reopen() {
  await act(async () => root.unmount());
  root = createRoot(container);
  await render();
}
const control = (label: string) =>
  container.querySelector<HTMLButtonElement>(`button[aria-label^="${label}:"]`);
const button = (text: string) =>
  [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === text,
  );
async function choose(label: string, option: string) {
  await act(async () => control(label)!.click());
  const item = [...document.body.querySelectorAll('[role="option"]')].find(
    (candidate) => candidate.textContent === option,
  ) as HTMLButtonElement;
  await act(async () => item.click());
}
async function click(text: string) {
  await act(async () => button(text)!.click());
}
async function submit() {
  await act(async () => {
    container
      .querySelector("textarea")!
      .form!.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
  });
}
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

it.each([
  ["codex", codexModel, "reasoningEffort", "Low", "high"],
  ["claude", claudeModel, "effort", "Medium", "max"],
] as const)(
  "changes %s effort between turns and sends the next turn with it",
  async (harness, model, setting, before, after) => {
    host = session(harness, model.id, {
      [setting]: before.toLowerCase(),
    });
    await render();
    expect(control("Reasoning")!.getAttribute("aria-label")).toBe(
      `Reasoning: ${before}`,
    );
    const label = after[0].toUpperCase() + after.slice(1);
    await choose("Reasoning", label);
    expect(container.textContent).toContain(
      "Apply settings to use them from the next turn.",
    );
    await type("Next step");
    await submit();
    expect(commands).toHaveLength(0);

    await click("Apply settings");
    expect(commands.at(-1)).toMatchObject({
      type: "configure",
      model: model.id,
      modelSettings: { [setting]: after },
    });
    expect(host.session.modelSettings).toEqual({ [setting]: after });
    expect(button("Apply settings")).toBeUndefined();

    await submit();
    expect(commands.at(-1)).toMatchObject({ type: "send", text: "Next step" });

    await reopen();
    expect(control("Reasoning")!.getAttribute("aria-label")).toBe(
      `Reasoning: ${label}`,
    );
    expect(button("Apply settings")).toBeUndefined();
  },
);

it("keeps effort configurable when the host catalog cannot be loaded", async () => {
  host = session("codex", codexModel.id, { reasoningEffort: "low" });
  catalog = new Error("Codex CLI is not authenticated");
  await render();
  expect(container.textContent).toContain(
    "Could not load models: Codex CLI is not authenticated",
  );
  expect(container.textContent).toContain(
    "Model details are unavailable, so these are this session's saved settings.",
  );
  expect(control("Reasoning")!.getAttribute("aria-label")).toBe(
    "Reasoning: Low",
  );
  await choose("Reasoning", "High");
  await click("Apply settings");
  expect(commands.at(-1)).toMatchObject({
    type: "configure",
    model: codexModel.id,
    modelSettings: { reasoningEffort: "high" },
  });

  catalog = { models: { codex: [codexModel] }, errors: {} };
  await click("Retry");
  expect(container.textContent).not.toContain("Could not load models");
  expect(container.textContent).not.toContain("saved settings");
  expect(control("Reasoning")!.getAttribute("aria-label")).toBe(
    "Reasoning: High",
  );
});

it("keeps saved effort visible when the host no longer lists the model", async () => {
  host = session("codex", "codex:retired", { reasoningEffort: "minimal" });
  await render();
  expect(container.textContent).toContain(
    "The host no longer lists codex:retired.",
  );
  expect(control("Remote model")!.getAttribute("aria-label")).toBe(
    "Remote model: codex:retired (not listed by host)",
  );
  expect(control("Reasoning")!.getAttribute("aria-label")).toBe(
    "Reasoning: Minimal (saved)",
  );
  await choose("Reasoning", "Medium");
  await click("Apply settings");
  expect(commands.at(-1)).toMatchObject({
    model: "codex:retired",
    modelSettings: { reasoningEffort: "medium" },
  });

  // Moving to a listed model keeps a compatible effort choice.
  await choose("Remote model", "GPT Test");
  expect(control("Reasoning")!.getAttribute("aria-label")).toBe(
    "Reasoning: Medium",
  );
  await click("Apply settings");
  expect(commands.at(-1)).toMatchObject({
    model: codexModel.id,
    modelSettings: { reasoningEffort: "medium" },
  });
});

it("matches a saved model after the host changes its catalog ids", async () => {
  host = session("claude", "claude:opus-4.6", { effort: "max" });
  await render();
  expect(control("Remote model")!.getAttribute("aria-label")).toBe(
    "Remote model: Claude Opus 4.6",
  );
  expect(container.textContent).not.toContain("no longer lists");
  expect(control("Reasoning")!.getAttribute("aria-label")).toBe(
    "Reasoning: Max",
  );
});

it("offers a saved effort value that a changed catalog entry dropped", async () => {
  host = session("claude", claudeModel.id, { effort: "ultrathink" });
  await render();
  expect(control("Reasoning")!.getAttribute("aria-label")).toBe(
    "Reasoning: Ultrathink (saved)",
  );
  expect(button("Apply settings")).toBeUndefined();
});

it("reloads model details after reconnecting", async () => {
  vi.useFakeTimers();
  host = session("codex", codexModel.id, { reasoningEffort: "low" });
  catalog = new Error("Machine is unreachable");
  await render();
  expect(container.textContent).toContain("saved settings");
  expect(control("Reasoning")!.getAttribute("aria-label")).toBe(
    "Reasoning: Low",
  );
  offline = true;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3_500);
  });
  expect(container.textContent).toContain("Reconnecting");
  expect(control("Reasoning")!.getAttribute("aria-label")).toBe(
    "Reasoning: Low",
  );
  offline = false;
  catalog = { models: { codex: [codexModel] }, errors: {} };
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_000);
  });
  expect(container.textContent).toContain("Connected");
  expect(container.textContent).not.toContain("saved settings");
  expect(control("Remote model")!.getAttribute("aria-label")).toBe(
    "Remote model: GPT Test",
  );
});
