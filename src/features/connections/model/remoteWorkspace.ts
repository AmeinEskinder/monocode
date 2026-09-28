import { useCallback, useEffect, useState } from "react";
import type { GitDiffIndex } from "../../../platform/tauri/fs";
import { remoteRequest, useRemoteMachines } from "./connections";
import { remoteProjectFor } from "./remoteProjects";

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
  const [index, setIndex] = useState<GitDiffIndex | null>(null);
  const [error, setError] = useState("");
  const [refreshToken, setRefreshToken] = useState(0);
  const refresh = useCallback(() => setRefreshToken((value) => value + 1), []);

  useEffect(() => {
    setIndex(null);
    setError("");
  }, [cwd, executionCwd, machine?.id]);
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
            cwd: executionCwd,
          },
        );
        if (!disposed) {
          setIndex(next);
          setError("");
        }
      } catch (reason) {
        if (!disposed) {
          const message = String(reason).replace(/^Error: /, "");
          setIndex(null);
          setError(message);
        }
      }
      if (!disposed) timer = setTimeout(() => void poll(), 3000);
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [enabled, project?.projectId, machine?.id, executionCwd, refreshToken]);

  return { project, machine, index, error, refresh };
}
