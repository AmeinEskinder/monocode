export type RemoteFileTarget = {
  machineId: string;
  projectId: string;
  projectKey: string;
  cwd: string;
  relativePath: string;
};

export function remoteFilePath(target: RemoteFileTarget): string {
  return `${target.cwd.replace(/[\\/]+$/, "")}/${target.relativePath}`;
}
