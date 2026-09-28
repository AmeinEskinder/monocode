import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { HostEngine } from "./engine";
import { HostStore } from "./store";
import {
  createHostWorktree,
  hostWorktrees,
  resolveHostWorktree,
} from "./git-worktrees";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it("creates registered host worktrees and binds new sessions to the selected checkout", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "monocode-host-worktrees-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd });
  git("init", "-q");
  git("checkout", "-q", "-b", "main");
  writeFileSync(join(cwd, "file.txt"), "initial\n");
  git("add", "file.txt");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-q",
    "-m",
    "initial",
  );
  git("branch", "existing");
  const store = new HostStore(join(cwd, "host.db"));
  const engine = new HostEngine(store, {
    codex: {
      send: async () => {},
      cancel: async () => {},
      stop: async () => {},
      bind: () => {},
      approve: () => {},
      answer: () => {},
    },
  });
  const project = store.addProject(cwd, "Test");
  const root = (await hostWorktrees(cwd)).defaultRoot;
  cleanups.push(async () => {
    await engine.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  const tree = await createHostWorktree(cwd, "feature/task", "HEAD", false);
  expect(tree).toMatchObject({
    branch: "feature/task",
    isMain: false,
    missing: false,
  });
  expect(resolveHostWorktree(cwd, tree.path)).toBe(tree.path);
  const listed = await hostWorktrees(cwd);
  expect(listed.worktrees.map((item) => item.branch)).toEqual([
    "main",
    "feature/task",
  ]);
  const receipt = engine.command({
    type: "create",
    commandId: "worktree-session",
    projectId: project.id,
    worktreeCwd: tree.path,
    harness: "codex",
    model: "codex:test",
    runtimeMode: "supervised",
  });
  expect(store.session(receipt.sessionId).session.cwd).toBe(tree.path);
  expect(() =>
    engine.command({
      type: "create",
      commandId: "outside",
      projectId: project.id,
      worktreeCwd: tmpdir(),
      harness: "codex",
      model: "codex:test",
      runtimeMode: "supervised",
    }),
  ).toThrow("Choose an available worktree");
  await expect(
    createHostWorktree(cwd, "feature/task", "HEAD", false),
  ).rejects.toThrow("already has a working copy");
  const existing = await createHostWorktree(cwd, "existing", "HEAD", true);
  expect(existing.branch).toBe("existing");
});
