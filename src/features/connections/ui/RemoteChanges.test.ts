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
