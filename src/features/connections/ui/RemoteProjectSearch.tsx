import { useCallback } from "react";
import { ProjectSearch } from "../../projects/ui/ProjectSearch";
import type {
  ProjectSearchMatch,
  ProjectSearchOptions,
  ProjectSearchResult,
} from "../../search/model/search";
import { remoteRequest } from "../model/connections";
import type { RemoteFileTarget } from "../model/remoteFiles";
import type { RemoteProject } from "../model/remoteProjects";
import type { RemoteMachine } from "../model/protocol";

export function RemoteProjectSearch({
  project,
  machine,
  cwd,
  focusToken,
  onOpenFile,
  onClose,
}: {
  project?: RemoteProject;
  machine?: RemoteMachine;
  cwd?: string;
  focusToken?: number;
  onOpenFile?: (target: RemoteFileTarget) => void;
  onClose: () => void;
}) {
  const workspaceCwd = cwd ?? project?.cwd ?? "";
  const projectId = project?.projectId;
  const machineId = machine?.id;
  const search = useCallback(
    async (options: ProjectSearchOptions): Promise<ProjectSearchResult> => {
      if (!machineId || !projectId)
        throw new Error("Connect this project’s machine to search files.");
      try {
        return await remoteRequest<ProjectSearchResult>(
          machineId,
          "files.searchContent",
          { ...options, projectId, cwd: workspaceCwd },
        );
      } catch (reason) {
        if (/Unsupported (host method|remote operation)/i.test(String(reason)))
          throw new Error(
            "Update MonoCode Host in Connections settings to search remote files.",
          );
        throw reason;
      }
    },
    [machineId, projectId, workspaceCwd],
  );
  const openMatch = (match: ProjectSearchMatch, pin: boolean) => {
    if (!project || !machine || !onOpenFile) return;
    onOpenFile({
      machineId: machine.id,
      projectId: project.projectId,
      projectKey: project.key,
      cwd: workspaceCwd,
      relativePath: match.relative,
      navigation: { line: match.line, column: match.column },
      pin,
    });
  };
  return (
    <ProjectSearch
      cwd={workspaceCwd}
      focusToken={focusToken || 1}
      search={search}
      onOpenMatch={openMatch}
      onClose={onClose}
    />
  );
}
