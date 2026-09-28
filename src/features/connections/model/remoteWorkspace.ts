import { useCallback, useEffect, useState } from "react";
import type { GitDiffIndex } from "../../../platform/tauri/fs";
import { remoteRequest, useRemoteMachines } from "./connections";
import { remoteProjectFor } from "./remoteProjects";

const cachedIndexes = new Map<string, GitDiffIndex>();

export function useRemoteWorkspace(
  cwd: string,
  executionCwd: string | undefined,
  enabled: boolean,
) {
  const project = remoteProjectFor(cwd);
  const { machines } = useRemoteMachines(!!project);
  const machine = machines.find(
    (entry) => entry.environmentId === project?.environmentId,
  );
  const workspaceCwd = executionCwd ?? project?.cwd;
  const key =
    project && machine
      ? JSON.stringify([machine.id, project.projectId, workspaceCwd])
      : "";
  const [result, setResult] = useState<{
    key: string;
    index: GitDiffIndex | null;
    error: string;
  }>({ key: "", index: null, error: "" });
  const index =
    result.key === key ? result.index : (cachedIndexes.get(key) ?? null);
  const error = result.key === key ? result.error : "";
  const [refreshToken, setRefreshToken] = useState(0);
  const refresh = useCallback(() => setRefreshToken((value) => value + 1), []);

  useEffect(() => {
    if (!enabled || !project || !machine) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await remoteRequest<GitDiffIndex>(
          machine.id,
          "git.index",
          {
            projectId: project.projectId,
            cwd: workspaceCwd,
          },
        );
        if (!disposed) {
          cachedIndexes.set(key, next);
          setResult({ key, index: next, error: "" });
        }
      } catch (reason) {
        if (!disposed) {
          const message = String(reason).replace(/^Error: /, "");
          setResult({
            key,
            index: cachedIndexes.get(key) ?? null,
            error: message,
          });
        }
      }
      if (!disposed) timer = setTimeout(() => void poll(), 3000);
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [
    enabled,
    project?.projectId,
    machine?.id,
    workspaceCwd,
    key,
    refreshToken,
  ]);

  return { project, machine, index, error, refresh };
}
