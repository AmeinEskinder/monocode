import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const options = (cwd: string) => ({
  cwd,
  timeout: 10_000,
  maxBuffer: 1024 * 1024,
});

export type HostBranches = { current: string | null; branches: string[] };

export async function hostBranches(cwd: string): Promise<HostBranches> {
  const [{ stdout: names }, current] = await Promise.all([
    exec(
      "git",
      ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
      options(cwd),
    ),
    exec("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], options(cwd))
      .then(({ stdout }) => stdout.trim())
      .catch(() => null),
  ]);
  return { current, branches: names.split("\n").filter(Boolean) };
}

export async function switchHostBranch(
  cwd: string,
  branch: unknown,
): Promise<HostBranches> {
  if (
    typeof branch !== "string" ||
    branch.length > 255 ||
    !branch ||
    branch.startsWith("-")
  )
    throw new Error("Invalid branch");
  const state = await hostBranches(cwd);
  if (!state.branches.includes(branch))
    throw new Error("Choose an existing local branch");
  if (state.current === branch) return state;
  const { stdout: changes } = await exec(
    "git",
    ["status", "--porcelain", "--untracked-files=all"],
    options(cwd),
  );
  if (changes)
    throw new Error(
      "Commit or stash changes on the host before switching branches",
    );
  await exec("git", ["switch", branch], options(cwd));
  return hostBranches(cwd);
}
