import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import {
  applySessionSync,
  type HostCommand,
  type HostProject,
  type HostSession,
  type HostSessionSummary,
  type RemoteMachine,
  type SessionSync,
} from "./protocol";

const CHANGE = "monocode:remote-machines";
const HISTORY_CHANGE = "monocode:remote-history";
export const OPEN_CONNECTIONS_EVENT = "monocode:open-connections";
export const refreshRemoteMachines = () =>
  window.dispatchEvent(new Event(CHANGE));
const KEY = "monocode.remote-projects.v1";
const TAB_KEY = "monocode.remote-tabs.v1";
export type RemoteTabSelection = { machineId: string; sessionId?: string };
export function remoteTabFor(shellId: string): RemoteTabSelection | undefined {
  try {
    const all = JSON.parse(localStorage.getItem(TAB_KEY) ?? "{}");
    return all[shellId];
  } catch {
    return undefined;
  }
}
export function rememberRemoteTab(
  shellId: string,
  machineId?: string,
  sessionId?: string,
) {
  try {
    const all = JSON.parse(localStorage.getItem(TAB_KEY) ?? "{}");
    if (machineId) all[shellId] = { machineId, sessionId };
    else delete all[shellId];
    localStorage.setItem(TAB_KEY, JSON.stringify(all));
  } catch {
    /* tab selection is best effort */
  }
}
type ProjectConnections = {
  machineId?: string;
  workspaces?: Record<string, HostProject>;
  sessions?: Record<string, string>;
  drafts?: Record<string, string>;
};

function read(project: string): ProjectConnections {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}")[project] ?? {};
  } catch {
    return {};
  }
}
function update(project: string, patch: Partial<ProjectConnections>) {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    all[project] = { ...read(project), ...patch };
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* preferences are best effort; host state is durable */
  }
}

export const rememberedMachine = (project: string): string | undefined =>
  read(project).machineId;
export const rememberMachine = (project: string, machineId?: string) =>
  update(project, { machineId });
export const workspaceFor = (
  project: string,
  environment: string,
): HostProject | undefined => read(project).workspaces?.[environment];
export const rememberWorkspace = (
  project: string,
  environment: string,
  workspace: HostProject,
) => {
  update(project, {
    workspaces: { ...read(project).workspaces, [environment]: workspace },
  });
  window.dispatchEvent(new Event(HISTORY_CHANGE));
};
export const rememberedSession = (
  project: string,
  environment: string,
): string | undefined => read(project).sessions?.[environment];
export const rememberSession = (
  project: string,
  environment: string,
  sessionId: string,
) => {
  update(project, {
    sessions: { ...read(project).sessions, [environment]: sessionId },
  });
  window.dispatchEvent(new Event(HISTORY_CHANGE));
};
export const remoteDraft = (project: string, key: string): string =>
  read(project).drafts?.[key] ?? "";
export const saveRemoteDraft = (project: string, key: string, draft: string) =>
  update(project, { drafts: { ...read(project).drafts, [key]: draft } });
const pendingPrefix = (project: string, environment: string) =>
  `monocode.remote-command.v1:${JSON.stringify([project, environment])}:`;

export const pendingRemoteCommand = (
  project: string,
  environment: string,
  sessionId?: string | null,
): HostCommand | undefined => {
  const prefix = pendingPrefix(project, environment);
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (key?.startsWith(prefix)) {
      const value = localStorage.getItem(key);
      if (value) {
        const command = JSON.parse(value) as HostCommand;
        if (
          sessionId === undefined ||
          (sessionId === null
            ? command.type === "create"
            : command.type !== "create" && command.sessionId === sessionId)
        )
          return command;
      }
    }
  }
};

// Each command owns its storage entry: a late receipt from another pane can
// never erase this pane's uncertain request. Persistence must succeed before
// dispatch; unlike preferences, silently dropping an outbox entry is unsafe.
export const savePendingRemoteCommand = (
  project: string,
  environment: string,
  command: HostCommand,
) => {
  try {
    localStorage.setItem(
      `${pendingPrefix(project, environment)}${command.commandId}`,
      JSON.stringify(command),
    );
  } catch {
    throw new Error(
      "Cannot save your request locally. Free up app storage before sending.",
    );
  }
};
export const clearPendingRemoteCommand = (
  project: string,
  environment: string,
  commandId: string,
) =>
  localStorage.removeItem(`${pendingPrefix(project, environment)}${commandId}`);

export function remoteRequest<T>(
  machineId: string,
  method: string,
  params: unknown = {},
): Promise<T> {
  return invoke<T>("remote_request", { machineId, method, params });
}

/** Fetches only what changed since `known`; falls back to a full snapshot. */
export async function loadRemoteSession(
  machineId: string,
  sessionId: string,
  known?: HostSession,
): Promise<HostSession> {
  const sync = (revision?: number) =>
    remoteRequest<SessionSync>(machineId, "sessions.sync", {
      sessionId,
      revision,
    });
  const update = await sync(known?.revision);
  try {
    return applySessionSync(known, update);
  } catch {
    return applySessionSync(undefined, await sync());
  }
}

export async function connectMachine(
  name: string,
  url: string,
  token: string,
): Promise<RemoteMachine> {
  const machine = await invoke<RemoteMachine>("remote_connect", {
    name,
    url,
    token,
  });
  window.dispatchEvent(new Event(CHANGE));
  return machine;
}

export async function disconnectMachine(machineId: string): Promise<void> {
  await invoke("remote_disconnect", { machineId });
  window.dispatchEvent(new Event(CHANGE));
}

export function useRemoteMachines(enabled = true): {
  machines: RemoteMachine[];
  loaded: boolean;
} {
  const [state, setState] = useState<{
    machines: RemoteMachine[];
    loaded: boolean;
  }>({ machines: [], loaded: false });
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    const refresh = () => {
      void invoke<RemoteMachine[]>("remote_machines")
        .then((value) => {
          if (!disposed)
            setState({
              machines: Array.isArray(value) ? value : [],
              loaded: true,
            });
        })
        .catch(() => {
          if (!disposed) setState({ machines: [], loaded: true });
        });
    };
    refresh();
    window.addEventListener(CHANGE, refresh);
    return () => {
      disposed = true;
      window.removeEventListener(CHANGE, refresh);
    };
  }, [enabled]);
  return state;
}

export type RemoteHistoryGroup = {
  machine: RemoteMachine;
  sessions: HostSessionSummary[];
};

const historyKey = (project: string, environment: string) =>
  `monocode.remote-history.v1:${JSON.stringify([project, environment])}`;

function cachedSessions(
  project: string,
  environment: string,
): HostSessionSummary[] {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(historyKey(project, environment)) ?? "[]",
    );
    return Array.isArray(value) ? (value as HostSessionSummary[]) : [];
  } catch {
    return [];
  }
}

/** Keeps mapped remote sessions visible in the project sidebar across reconnects. */
export function useRemoteProjectSessions(
  project: string,
  enabled = true,
): RemoteHistoryGroup[] {
  const { machines } = useRemoteMachines(enabled);
  const [groups, setGroups] = useState<RemoteHistoryGroup[]>([]);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const changed = () => setRefresh((value) => value + 1);
    window.addEventListener(HISTORY_CHANGE, changed);
    return () => window.removeEventListener(HISTORY_CHANGE, changed);
  }, [enabled]);
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const mapped = machines.flatMap((machine) => {
        const workspace = workspaceFor(project, machine.environmentId);
        return workspace ? [{ machine, workspace }] : [];
      });
      const rows = await Promise.all(
        mapped.map(async ({ machine, workspace }) => {
          let sessions = cachedSessions(project, machine.environmentId);
          try {
            sessions = await remoteRequest<HostSessionSummary[]>(
              machine.id,
              "sessions.list",
              { projectId: workspace.id },
            );
            localStorage.setItem(
              historyKey(project, machine.environmentId),
              JSON.stringify(sessions),
            );
          } catch {
            // Last known history stays navigable while the machine reconnects.
          }
          return {
            machine,
            sessions,
          };
        }),
      );
      if (disposed) return;
      setGroups(rows);
      timer = setTimeout(() => void poll(), 3_000);
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [enabled, project, machines, refresh]);
  return groups;
}
