// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { RemoteProjectSearch } from "./RemoteProjectSearch";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue({
    matches: [
      {
        path: "/repo/src/index.ts",
        relative: "src/index.ts",
        line: 3,
        column: 5,
        preview: "const answer = 42;",
      },
    ],
    truncated: false,
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

it("uses the local search panel and opens remote matches at their line", async () => {
  const onOpenFile = vi.fn();
  await act(async () =>
    root.render(
      createElement(RemoteProjectSearch, {
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
        onOpenFile,
        onClose: () => {},
      }),
    ),
  );
  expect(container.textContent).toContain("Search in files");
  expect(container.querySelector('[aria-label="Match case"]')).not.toBeNull();
  expect(
    container.querySelector('[aria-label="files to include"]'),
  ).not.toBeNull();
  const input = container.querySelector<HTMLInputElement>(
    '[aria-label="Search"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, "answer");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
  });
  expect(invoke).toHaveBeenCalledWith(
    "remote_request",
    expect.objectContaining({
      method: "files.searchContent",
      params: expect.objectContaining({
        projectId: "project",
        query: "answer",
      }),
    }),
  );
  const result = [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("const answer = 42;"),
  );
  await act(async () => result!.click());
  expect(onOpenFile).toHaveBeenCalledWith(
    expect.objectContaining({
      cwd: "/repo",
      relativePath: "src/index.ts",
      navigation: { line: 3, column: 5 },
    }),
  );
});
