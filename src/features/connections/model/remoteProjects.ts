import {
  isRemoteProjectPath,
  REMOTE_PROJECT_PREFIX,
} from "../../projects/model/recents";
import type { HostProject } from "./protocol";

/** A rail project whose folder lives on another machine. */
export type RemoteProject = {
  key: string;
  environmentId: string;
  /** The host's ID for this folder. */
  projectId: string;
  /** The folder's path on the host. */
  cwd: string;
};

const KEY = "monocode.remote-projects.v2";
export const REMOTE_PROJECTS_CHANGED = "monocode:remote-projects-changed";

const slashed = (path: string) => path.replace(/\\/g, "/");

export function remoteProjectKey(environmentId: string, cwd: string): string {
  const path = slashed(cwd).replace(/\/+$/, "").replace(/^\/+/, "");
  return `${REMOTE_PROJECT_PREFIX}${environmentId}/${path}`;
}

function readAll(): Record<string, RemoteProject> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return value && typeof value === "object"
      ? (value as Record<string, RemoteProject>)
      : {};
  } catch {
    return {};
  }
}

export function remoteProjectFor(path: string): RemoteProject | undefined {
  if (!isRemoteProjectPath(path)) return undefined;
  const key = slashed(path).replace(/\/+$/, "");
  return readAll()[key];
}

export function rememberRemoteProject(
  environmentId: string,
  project: HostProject,
): RemoteProject {
  const remote: RemoteProject = {
    key: remoteProjectKey(environmentId, project.cwd),
    environmentId,
    projectId: project.id,
    cwd: project.cwd,
  };
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({ ...readAll(), [remote.key]: remote }),
    );
  } catch {
    /* the rail entry still works for this session */
  }
  window.dispatchEvent(new Event(REMOTE_PROJECTS_CHANGED));
  return remote;
}

export function remoteProjectsOn(environmentId: string): RemoteProject[] {
  return Object.values(readAll()).filter(
    (project) => project.environmentId === environmentId,
  );
}
