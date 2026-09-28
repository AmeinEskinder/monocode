import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  lstat,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  GitChangedFile,
  GitDiffIndex,
  GitFileDiff,
} from "../src/platform/tauri/fs";

const exec = promisify(execFile);
const MAX_FILE = 1024 * 1024;

function workspacePath(
  root: string,
  input: unknown,
  allowRoot = false,
): string {
  if (typeof input !== "string" || input.length > 4096 || input.includes("\0"))
    throw new Error("Invalid workspace path");
  const path = resolve(root, input);
  const rel = relative(root, path);
  if (
    (!allowRoot && !rel) ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel) ||
    rel.split(sep).some((part) => part.toLowerCase() === ".git")
  )
    throw new Error("Path is outside the workspace");
  return path;
}

async function existingPath(root: string, input: unknown, allowRoot = false) {
  const path = workspacePath(root, input, allowRoot);
  const actual = await realpath(path);
  const rel = relative(root, actual);
  if (
    (!allowRoot && !rel) ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel) ||
    rel.split(sep).some((part) => part.toLowerCase() === ".git")
  )
    throw new Error("Path is outside the workspace");
  return actual;
}

async function git(root: string, args: string[], maxBuffer = 4 * 1024 * 1024) {
  return (
    await exec("git", ["-c", "core.pager=cat", ...args], {
      cwd: root,
      timeout: 10_000,
      maxBuffer,
      encoding: "utf8",
    })
  ).stdout;
}

export type HostFileEntry = {
  name: string;
  path: string;
  isDir: boolean;
  ignored: boolean;
};

export async function listHostFiles(
  root: string,
  input: unknown,
): Promise<HostFileEntry[]> {
  const dir = await existingPath(root, input, true);
  if (!(await stat(dir)).isDirectory())
    throw new Error("Path is not a directory");
  const entries = await readdir(dir, { withFileTypes: true });
  if (entries.length > 5000)
    throw new Error("Directory has too many entries to display");
  const visible = entries.filter((entry) => entry.name !== ".DS_Store");
  const paths = visible.map((entry) =>
    relative(root, resolve(dir, entry.name)).split(sep).join("/"),
  );
  let ignored = new Set<string>();
  if (paths.length) {
    try {
      const output = await git(root, ["check-ignore", "-z", "--", ...paths]);
      ignored = new Set(output.split("\0").filter(Boolean));
    } catch {
      /* no ignored entries or a non-Git folder */
    }
  }
  const out = await Promise.all(
    visible.map(async (entry, index) => {
      const path = paths[index];
      const isDir =
        entry.isDirectory() ||
        (entry.isSymbolicLink() &&
          (await existingPath(root, path)
            .then((actual) => stat(actual))
            .then((value) => value.isDirectory())
            .catch(() => false)));
      return {
        name: entry.name,
        path,
        isDir,
        ignored: entry.name === ".git" || ignored.has(path),
      };
    }),
  );
  return out.sort(
    (a, b) =>
      Number(b.isDir) - Number(a.isDir) ||
      a.name.localeCompare(b.name, undefined, {
        numeric: true,
        sensitivity: "base",
      }),
  );
}

/** Bounded filename search for the remote Explorer and Go to File. */
export async function searchHostFiles(
  root: string,
  input: unknown,
): Promise<HostFileEntry[]> {
  if (typeof input !== "string" || input.length > 200)
    throw new Error("Invalid search");
  const query = input.trim().toLocaleLowerCase();
  if (!query) return [];
  let paths: string[];
  try {
    paths = (
      await git(
        root,
        ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        8 * 1024 * 1024,
      )
    )
      .split("\0")
      .filter(Boolean);
  } catch {
    paths = [];
    const pending = [""];
    while (pending.length && paths.length < 5000) {
      const dir = pending.pop()!;
      const entries = await readdir(resolve(root, dir), {
        withFileTypes: true,
      }).catch(() => []);
      for (const entry of entries) {
        if (entry.name === ".git" || entry.name === "node_modules") continue;
        const path = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) pending.push(path);
        else if (entry.isFile()) paths.push(path);
      }
    }
  }
  return paths
    .filter((path) => path.toLocaleLowerCase().includes(query))
    .slice(0, 200)
    .map((path) => ({
      name: path.split("/").pop() || path,
      path,
      isDir: false,
      ignored: false,
    }));
}

export async function readHostFile(
  root: string,
  input: unknown,
): Promise<string> {
  const path = await existingPath(root, input);
  const info = await stat(path);
  if (!info.isFile()) throw new Error("Path is not a file");
  if (info.size > MAX_FILE) throw new Error("File is too large to preview");
  const bytes = await readFile(path);
  if (bytes.includes(0)) throw new Error("Binary file cannot be previewed");
  return bytes.toString("utf8");
}

export async function writeHostFile(
  root: string,
  input: unknown,
  expected: unknown,
  content: unknown,
) {
  if (
    typeof expected !== "string" ||
    typeof content !== "string" ||
    Buffer.byteLength(content, "utf8") > MAX_FILE ||
    content.includes("\0")
  )
    throw new Error("Invalid file content");
  const path = await existingPath(root, input);
  const current = await readHostFile(root, input);
  if (current !== expected)
    throw new Error("File changed on the host; reload before saving");
  await writeFile(path, content, "utf8");
}

function statusName(code: string): string {
  if (code === "??") return "untracked";
  if (code.includes("D")) return "deleted";
  if (code.includes("A") || code.includes("?")) return "added";
  return "modified";
}

export async function hostGitIndex(root: string): Promise<GitDiffIndex> {
  // An ordinary folder has an empty Changes view, just as it does locally.
  const repository = await git(root, [
    "rev-parse",
    "--is-inside-work-tree",
  ]).catch((error) => {
    if (String(error).includes("not a git repository")) return "";
    throw error;
  });
  if (repository.trim() !== "true") {
    return {
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
  }
  const [
    branchText,
    headText,
    statusText,
    numstat,
    remoteText,
    upstreamText,
    countsText,
    defaultText,
  ] = await Promise.all([
    git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => ""),
    git(root, ["rev-parse", "--verify", "HEAD"]).catch(() => ""),
    git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    git(root, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--numstat",
      "HEAD",
      "--",
    ]).catch(() => ""),
    git(root, ["remote", "get-url", "origin"]).catch(() => ""),
    git(root, [
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{upstream}",
    ]).catch(() => ""),
    git(root, [
      "rev-list",
      "--left-right",
      "--count",
      "@{upstream}...HEAD",
    ]).catch(() => ""),
    git(root, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "refs/remotes/origin/HEAD",
    ]).catch(() => ""),
  ]);
  const [behind, ahead] = countsText.trim().split(/\s+/).map(Number);
  let defaultBranch = defaultText.trim().replace(/^origin\//, "");
  if (!defaultBranch && remoteText.trim()) {
    for (const name of ["main", "master"]) {
      const exists = await git(root, [
        "rev-parse",
        "--verify",
        `refs/remotes/origin/${name}`,
      ]).then(
        () => true,
        () => false,
      );
      if (exists) {
        defaultBranch = name;
        break;
      }
    }
  }
  const aheadOfDefault = defaultBranch
    ? Number(
        (
          await git(root, [
            "rev-list",
            "--count",
            `origin/${defaultBranch}..HEAD`,
          ]).catch(() => "0")
        ).trim(),
      ) || 0
    : 0;
  const counts = new Map<string, { additions: number; deletions: number }>();
  for (const line of numstat.split("\n")) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (match)
      counts.set(match[3], {
        additions: Number(match[1]) || 0,
        deletions: Number(match[2]) || 0,
      });
  }
  const parts = statusText.split("\0");
  const files: GitChangedFile[] = [];
  for (let index = 0; index < parts.length; index++) {
    const item = parts[index];
    if (!item || item.length < 4) continue;
    const code = item.slice(0, 2);
    const path = item.slice(3);
    if (code.includes("R") || code.includes("C")) index++;
    const count = counts.get(path) ?? { additions: 0, deletions: 0 };
    if (code === "??") {
      try {
        const info = await lstat(resolve(root, path));
        if (info.size <= MAX_FILE && info.isFile()) {
          const content = await readFile(resolve(root, path), "utf8");
          count.additions = content
            ? content.split("\n").length - Number(content.endsWith("\n"))
            : 0;
        }
      } catch {
        /* a file may change during refresh */
      }
    }
    files.push({
      path,
      relative: path,
      status: statusName(code),
      additions: count.additions,
      deletions: count.deletions,
      staged: code[0] !== " " && code !== "??",
      unstaged: code[1] !== " " || code === "??",
    });
  }
  files.sort((a, b) => a.relative.localeCompare(b.relative));
  return {
    branch: branchText.trim() || null,
    head: headText.trim() || null,
    files,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    remote: remoteText.trim() ? "origin" : null,
    upstream: upstreamText.trim() || null,
    defaultBranch: defaultBranch || null,
    ahead: ahead || 0,
    behind: behind || 0,
    aheadOfDefault,
    headPushed: false,
  };
}

async function gitBlob(root: string, spec: string) {
  try {
    const text = await git(root, ["show", spec], MAX_FILE + 1024);
    return { text, binary: text.includes("\0"), tooLarge: false };
  } catch (error) {
    return {
      text: "",
      binary: false,
      tooLarge: String(error).includes("maxBuffer"),
    };
  }
}

export async function hostFileDiff(
  root: string,
  input: unknown,
  staged: boolean,
): Promise<GitFileDiff> {
  const path = workspacePath(root, input);
  const relativePath = relative(root, path).split(sep).join("/");
  const index = await hostGitIndex(root);
  const file = index.files.find((entry) => entry.relative === relativePath);
  if (!file) throw new Error("File has no uncommitted changes");
  const original = await gitBlob(
    root,
    `${staged ? "HEAD" : ""}:${relativePath}`,
  );
  const current = staged
    ? await gitBlob(root, `:${relativePath}`)
    : await readHostFile(root, relativePath).then(
        (text) => ({ text, binary: false, tooLarge: false }),
        (error) => {
          if (file.status === "deleted")
            return { text: "", binary: false, tooLarge: false };
          if (String(error).includes("too large"))
            return { text: "", binary: false, tooLarge: true };
          if (String(error).includes("Binary file"))
            return { text: "", binary: true, tooLarge: false };
          throw error;
        },
      );
  return {
    path: relativePath,
    relative: relativePath,
    status: file.status,
    original: original.text,
    current: current.text,
    binary: original.binary || current.binary,
    tooLarge: original.tooLarge || current.tooLarge,
  };
}

export async function hostGitAction(
  root: string,
  action: unknown,
  input?: unknown,
  message?: unknown,
) {
  const discard = async (file: GitChangedFile) => {
    const path = relative(root, workspacePath(root, file.relative));
    if (file.status === "untracked") await rm(resolve(root, path));
    else await git(root, ["restore", "--worktree", "--", path]);
  };
  switch (action) {
    case "stage":
    case "unstage": {
      const path = relative(root, workspacePath(root, input));
      await git(
        root,
        action === "stage"
          ? ["add", "--", path]
          : ["restore", "--staged", "--", path],
      );
      return;
    }
    case "stageAll":
      await git(root, ["add", "-A", "--", "."]);
      return;
    case "unstageAll":
      await git(root, ["reset", "-q", "--", "."]);
      return;
    case "discard": {
      const path = relative(root, workspacePath(root, input));
      const file = (await hostGitIndex(root)).files.find(
        (entry) => entry.relative === path && entry.unstaged,
      );
      if (!file) throw new Error("File has no changes to discard");
      await discard(file);
      return;
    }
    case "discardAll":
      for (const file of (await hostGitIndex(root)).files.filter(
        (entry) => entry.unstaged,
      ))
        await discard(file);
      return;
    case "commit": {
      if (
        typeof message !== "string" ||
        !message.trim() ||
        message.length > 100_000
      )
        throw new Error("Enter a commit message");
      await git(root, ["commit", "-m", message], 1024 * 1024);
      return;
    }
    case "push":
      await git(root, ["push", "-u", "origin", "HEAD"]);
      return;
    case "createPr": {
      const output = await exec("gh", ["pr", "create", "--fill"], {
        cwd: root,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        env: {
          ...process.env,
          GH_PROMPT_DISABLED: "1",
          GIT_TERMINAL_PROMPT: "0",
        },
      });
      return output.stdout.trim();
    }
    default:
      throw new Error("Unsupported Git action");
  }
}
