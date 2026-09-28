import type { ProjectFile } from "../../../platform/tauri/fs";
import {
  cachedRemoteSessionSummary,
  remotePendingWorktree,
  remoteRequest,
  remoteSessionFor,
} from "./connections";

/** A checkout on a machine whose files Go to File lists. */
export type RemoteFileSource = {
  machineId: string;
  projectId: string;
  projectKey: string;
  /** The checkout's path on the host. */
  cwd: string;
};

const cache = new Map<string, ProjectFile[]>();
const cacheKey = (source: RemoteFileSource) =>
  JSON.stringify([source.machineId, source.projectId, source.cwd]);

/** The host checkout a remote tab works in: its session's worktree, or the one
 * picked before its first message. Undefined means the project folder. */
export function remoteTabCwd(
  project: string,
  shellId?: string,
): string | undefined {
  if (!shellId) return undefined;
  const sessionId = remoteSessionFor(shellId);
  return (
    (sessionId
      ? cachedRemoteSessionSummary(project, sessionId)?.cwd
      : undefined) ?? remotePendingWorktree(shellId)
  );
}

export function peekRemoteFiles(
  source: RemoteFileSource,
): ProjectFile[] | undefined {
  return cache.get(cacheKey(source));
}

/** Lists every file in the checkout so Go to File can rank them locally, the
 * same way it ranks a local project's files. */
export async function loadRemoteFiles(
  source: RemoteFileSource,
): Promise<ProjectFile[]> {
  let paths: string[];
  try {
    paths = await remoteRequest<string[]>(source.machineId, "files.index", {
      projectId: source.projectId,
      cwd: source.cwd,
    });
  } catch (reason) {
    if (/Unsupported (host method|remote operation)/i.test(String(reason)))
      throw new Error(
        "Update MonoCode Host in Connections settings to go to files on this machine.",
      );
    throw reason;
  }
  const root = source.cwd.replace(/[\\/]+$/, "");
  const files = paths.map((relative) => ({
    name: relative.split("/").pop() || relative,
    path: `${root}/${relative}`,
    relative,
  }));
  cache.set(cacheKey(source), files);
  return files;
}
