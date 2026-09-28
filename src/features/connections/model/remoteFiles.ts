import type { EditorNavigation } from "../../search/model/search";
import type { GitFileDiffKind } from "../../../platform/tauri/fs";

export type RemoteFileTarget = {
  machineId: string;
  projectId: string;
  projectKey: string;
  cwd: string;
  relativePath: string;
  navigation?: EditorNavigation;
  pin?: boolean;
  changeKind?: GitFileDiffKind;
};

export function remoteFilePath(target: RemoteFileTarget): string {
  return `${target.cwd.replace(/[\\/]+$/, "")}/${target.relativePath}`;
}
