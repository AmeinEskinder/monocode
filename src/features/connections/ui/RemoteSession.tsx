import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { SessionPaneProps } from "../../sessions/ui/SessionPane";
import type {
  Attachment,
  Block,
  ComposerTurnOptions,
  HarnessId,
  RuntimeMode,
  Session,
  WorkspaceMode,
} from "../../sessions/model/session";
import { uploadRemoteAttachments } from "../model/remoteAttachments";
import { temporaryWorktreeBranchName } from "../../source-control/model/worktrees";
import type { AgentModel } from "../../sessions/model/models";
import {
  ModelSourceContext,
  type ModelSource,
} from "../../sessions/ui/modelSource";
import { GitPickerTrigger } from "../../source-control/ui/GitPickerTrigger";
import { CreateBranchDialog } from "../../source-control/ui/CreateBranchDialog";
import { Popover } from "../../../shared/ui/Popover";
import {
  Check,
  GitBranch,
  Plus,
  Search,
  X,
} from "../../../shared/ui/icons";
import {
  clearPendingRemoteCommand,
  loadRemoteSession,
  OPEN_CONNECTIONS_EVENT,
  pendingRemoteCommand,
  rememberRemotePendingWorktree,
  rememberRemoteSession,
  REMOTE_HISTORY_CHANGE,
  remoteRequest,
  reportRemoteMachineStatus,
  remotePendingWorktree,
  remoteSessionFor,
  savePendingRemoteCommand,
  useRemoteMachines,
} from "../model/connections";
import { remoteProjectFor, type RemoteProject } from "../model/remoteProjects";
import {
  carryModelSettings,
  findRemoteModel,
  remoteModelControls,
  sameModelSettings,
} from "../model/remoteModels";
import {
  isRemoteProvider,
  requireHostDescriptor,
  type CommandReceipt,
  type HostBranches,
  type HostCommand,
  type HostDescriptor,
  type HostModelCatalog,
  type HostSession,
  type HostWorktree,
  type RemoteAttachment,
  type RemoteMachine,
  type RemoteProvider,
} from "../model/protocol";
import { RemoteWorktreePicker } from "./RemoteWorktreePicker";

export type RemoteSessionOverrides = Partial<SessionPaneProps> & {
  remoteHost: ReactNode;
  remoteFeatures: { attachments: boolean; plan: boolean; draft: boolean };
  remoteSessionLoading: boolean;
  allowedModelHarnesses: readonly HarnessId[];
};

type Configuration = {
  harness: RemoteProvider;
  model: string;
  settings: Record<string, string>;
  mode: RuntimeMode;
};

type OptimisticTurn = {
  commandId: string;
  text: string;
  attachments: Attachment[];
  intent: "default" | "plan" | "build";
  draft?: boolean;
  draftBlockId?: string;
  planBlockId?: string;
  startedAt: number;
  turnModel: NonNullable<Block["turnModel"]>;
};

const noop = () => {};
const cachedSessionSnapshots = new Map<string, HostSession>();
const cachedDescriptors = new Map<string, HostDescriptor>();
const cachedCatalogs = new Map<string, HostModelCatalog>();
const cachedBranches = new Map<string, HostBranches>();
const snapshotKey = (machineId: string, sessionId: string) =>
  `${machineId}:${sessionId}`;
const catalogKey = (machineId: string, projectId: string) =>
  JSON.stringify([machineId, projectId]);
const branchKey = (machineId: string, projectId: string, cwd: string) =>
  JSON.stringify([machineId, projectId, cwd]);
function rememberSessionSnapshot(key: string, snapshot: HostSession) {
  cachedSessionSnapshots.delete(key);
  cachedSessionSnapshots.set(key, snapshot);
  if (cachedSessionSnapshots.size > 8)
    cachedSessionSnapshots.delete(cachedSessionSnapshots.keys().next().value!);
}

/** Fetches a host conversation into the snapshot cache, so its tab opens with
 * the transcript already laid out, as a local session read from disk does. */
export async function preloadRemoteSession(
  machineId: string,
  sessionId: string,
): Promise<void> {
  const key = snapshotKey(machineId, sessionId);
  if (cachedSessionSnapshots.has(key)) return;
  rememberSessionSnapshot(key, await loadRemoteSession(machineId, sessionId));
}

/** A tab in a project on another machine. The host owns the session; this
 * renders the normal session pane with actions routed to the host. */
export function RemoteSession({
  shell,
  visible,
  onOpenWorktree,
  onSnapshot,
  render,
}: {
  /** The tab's local session, which provides its ID and new-session defaults. */
  shell: Session;
  visible: boolean;
  onOpenWorktree?: SessionPaneProps["onOpenRemoteWorktree"];
  onSnapshot?: (shellId: string, snapshot: HostSession) => void;
  render: (overrides: RemoteSessionOverrides) => ReactNode;
}) {
  const project = remoteProjectFor(shell.cwd);
  const { machines, loaded } = useRemoteMachines(!!project);
  const machine = project
    ? machines.find((entry) => entry.environmentId === project.environmentId)
    : undefined;
  if (!project || !machine)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-[13px] text-content/60">
          {!project
            ? "This project’s machine details are missing. Add the project again from the project rail."
            : loaded
              ? "The machine for this project isn’t connected on this computer."
              : "Connecting to the machine…"}
        </p>
        {project && loaded ? (
          <button
            type="button"
            className="rounded-lg bg-selection px-3 py-1.5 text-[12px] hover:bg-selection-hover"
            onClick={() =>
              window.dispatchEvent(new Event(OPEN_CONNECTIONS_EVENT))
            }
          >
            Manage machines
          </button>
        ) : null}
      </div>
    );
  return (
    <ConnectedRemoteSession
      key={`${machine.id}:${shell.id}`}
      shell={shell}
      visible={visible}
      onOpenWorktree={onOpenWorktree}
      onSnapshot={onSnapshot}
      machine={machine}
      project={project}
      render={render}
    />
  );
}

function ConnectedRemoteSession({
  shell,
  visible,
  onOpenWorktree,
  onSnapshot,
  machine,
  project,
  render,
}: {
  shell: Session;
  visible: boolean;
  onOpenWorktree?: SessionPaneProps["onOpenRemoteWorktree"];
  onSnapshot?: (shellId: string, snapshot: HostSession) => void;
  machine: RemoteMachine;
  project: RemoteProject;
  render: (overrides: RemoteSessionOverrides) => ReactNode;
}) {
  const [descriptor, setDescriptor] = useState<HostDescriptor | undefined>(() =>
    cachedDescriptors.get(machine.id),
  );
  const [online, setOnline] = useState(false);
  const [connectionError, setConnectionError] = useState("");
  const [error, setError] = useState("");
  const [sessionId, setSessionId] = useState(() => remoteSessionFor(shell.id));
  useEffect(() => {
    const changed = () => {
      const next = remoteSessionFor(shell.id);
      setSessionId(next);
      // A blank tab reused for a preloaded conversation shows it at once.
      const cached = next
        ? cachedSessionSnapshots.get(snapshotKey(machine.id, next))
        : undefined;
      if (cached) setSnapshot(cached);
    };
    window.addEventListener(REMOTE_HISTORY_CHANGE, changed);
    changed();
    return () => window.removeEventListener(REMOTE_HISTORY_CHANGE, changed);
  }, [shell.id, machine.id]);
  const [snapshot, setSnapshot] = useState<HostSession | undefined>(() =>
    sessionId
      ? cachedSessionSnapshots.get(snapshotKey(machine.id, sessionId))
      : undefined,
  );
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const [refresh, setRefresh] = useState(0);
  const [catalog, setCatalog] = useState<HostModelCatalog | undefined>(() =>
    cachedCatalogs.get(catalogKey(machine.id, project.projectId)),
  );
  const [catalogError, setCatalogError] = useState("");
  const [catalogRefresh, setCatalogRefresh] = useState(0);
  const initialCwd =
    snapshot && snapshot.session.id === sessionId
      ? snapshot.session.cwd
      : (remotePendingWorktree(shell.id) ?? project.cwd);
  const [branches, setBranches] = useState<HostBranches | undefined>(() =>
    cachedBranches.get(branchKey(machine.id, project.projectId, initialCwd)),
  );
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branchError, setBranchError] = useState("");
  const [branchRefresh, setBranchRefresh] = useState(0);
  const branchCwd = useRef(initialCwd);
  const [selectedCwd, setSelectedCwd] = useState(
    () => remotePendingWorktree(shell.id) ?? project.cwd,
  );
  const [draftWorkspaceMode, setDraftWorkspaceMode] =
    useState<WorkspaceMode>("current");
  const [draftWorktreeBase, setDraftWorktreeBase] = useState("HEAD");
  const [switchingBranch, setSwitchingBranch] = useState(false);
  const [preview, setPreview] = useState<{ title: string; text: string }>();
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const preparingRef = useRef(false);
  const [unseenSend, setUnseenSend] = useState<
    Pick<
      OptimisticTurn,
      | "commandId"
      | "text"
      | "startedAt"
      | "turnModel"
      | "attachments"
      | "draftBlockId"
    > & {
      sessionId: string;
    }
  >();
  // A first message waits here while its session is created on the host.
  const [starting, setStarting] = useState<
    OptimisticTurn & { failed?: boolean }
  >();
  const [pending, setPending] = useState(() =>
    pendingRemoteCommand(project.key, machine.environmentId, sessionId ?? null),
  );
  const [draft, setDraft] = useState<Configuration>(() => ({
    harness: shell.harness === "claude" ? "claude" : "codex",
    model: shell.model,
    settings: shell.modelSettings ?? {},
    mode: shell.runtimeMode,
  }));
  // Changes to a started session, applied when it is idle.
  const [changes, setChanges] = useState<Configuration>();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    setPending(
      pendingRemoteCommand(
        project.key,
        machine.environmentId,
        sessionId ?? null,
      ),
    );
  }, [project.key, machine.environmentId, sessionId]);

  const hostSession =
    snapshot && snapshot.session.id === sessionId
      ? snapshot.session
      : undefined;
  useEffect(() => {
    if (hostSession) rememberRemotePendingWorktree(shell.id);
  }, [hostSession?.id, shell.id]);
  const executionCwd = hostSession?.cwd ?? selectedCwd;
  useEffect(() => {
    if (hostSession?.branch) setBranchRefresh((value) => value + 1);
  }, [hostSession?.branch]);
  const activeSessionId = hostSession?.id ?? sessionId;
  const hasHostBlock = (commandId: string) =>
    !!hostSession?.blocks.some((block) => block.id === commandId);
  const unseenActive =
    !!unseenSend &&
    unseenSend.sessionId === activeSessionId &&
    !hasHostBlock(unseenSend.commandId);
  const startingActive =
    !!starting && !starting.failed && !hasHostBlock(starting.commandId);
  const pendingSendActive =
    (pending?.type === "send" || pending?.type === "compact") &&
    pending.sessionId === activeSessionId &&
    !hasHostBlock(pending.commandId);
  const busy =
    !!hostSession?.busy || unseenActive || startingActive || pendingSendActive;
  // An accepted turn stays on screen until a sync shows the host's copy, so
  // the transcript never drops it for a moment in between.
  useEffect(() => {
    if (starting && !starting.failed && hasHostBlock(starting.commandId))
      setStarting(undefined);
  }, [hostSession, starting]);
  // A draft being removed leaves the transcript at once, as it does locally,
  // and returns if the host turns the removal down.
  const [removingDraft, setRemovingDraft] = useState<string>();
  useEffect(() => {
    if (
      removingDraft &&
      !hostSession?.blocks.some((block) => block.id === removingDraft)
    )
      setRemovingDraft(undefined);
  }, [hostSession, removingDraft]);
  useEffect(() => {
    if (
      unseenSend &&
      hostSession?.id === unseenSend.sessionId &&
      hostSession.blocks.some((block) => block.id === unseenSend.commandId)
    )
      setUnseenSend((current) =>
        current?.commandId === unseenSend.commandId ? undefined : current,
      );
  }, [hostSession, unseenSend]);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    let failed = 0;
    // Every request carries the expected host identity; describe again only
    // after a failure, when the host may have been replaced.
    let described = false;
    const poll = async () => {
      let active = false;
      try {
        if (!described) {
          const host = requireHostDescriptor(
            await remoteRequest<HostDescriptor>(
              machine.id,
              "environment.describe",
            ),
          );
          if (host.environmentId !== machine.environmentId)
            throw new Error(
              "Host identity changed. Reconnect this machine before continuing.",
            );
          if (disposed) return;
          cachedDescriptors.set(machine.id, host);
          setDescriptor(host);
          described = true;
        }
        const known =
          snapshotRef.current?.session.id === sessionId
            ? snapshotRef.current
            : undefined;
        const next = sessionId
          ? await loadRemoteSession(machine.id, sessionId, known)
          : undefined;
        if (disposed) return;
        if (next && next.projectId !== project.projectId)
          throw new Error("This session belongs to a different host project");
        setOnline(true);
        reportRemoteMachineStatus(machine.id, true);
        setConnectionError("");
        // A catalog request that failed while offline is retried on recovery.
        if (failed) setCatalogRefresh((value) => value + 1);
        failed = 0;
        if (next && sessionId)
          rememberSessionSnapshot(snapshotKey(machine.id, sessionId), next);
        setSnapshot(next);
        if (next) onSnapshot?.(shell.id, next);
        active = !!next?.session.busy;
      } catch (reason) {
        if (disposed) return;
        setOnline(false);
        reportRemoteMachineStatus(machine.id, false);
        setConnectionError(String(reason));
        described = false;
        failed++;
      }
      if (!disposed)
        timer = setTimeout(
          () => void poll(),
          failed
            ? Math.min(10_000, 750 * 2 ** Math.min(failed, 4))
            : active
              ? 750
              : visible
                ? 3_000
                : 10_000,
        );
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [
    machine.id,
    machine.environmentId,
    project.projectId,
    sessionId,
    refresh,
    visible,
    onSnapshot,
  ]);

  useEffect(() => {
    if (!descriptor) return;
    let disposed = false;
    void remoteRequest<HostModelCatalog>(machine.id, "models.list", {
      projectId: project.projectId,
    })
      .then((value) => {
        if (disposed) return;
        cachedCatalogs.set(catalogKey(machine.id, project.projectId), value);
        setCatalog(value);
        setCatalogError("");
      })
      .catch((reason) => {
        if (!disposed) setCatalogError(String(reason));
      });
    return () => {
      disposed = true;
    };
  }, [
    machine.id,
    descriptor?.environmentId,
    project.projectId,
    catalogRefresh,
  ]);

  useEffect(() => {
    if (!online) return;
    let cancelled = false;
    if (branchCwd.current !== executionCwd) {
      branchCwd.current = executionCwd;
      setBranches(
        cachedBranches.get(
          branchKey(machine.id, project.projectId, executionCwd),
        ),
      );
    }
    setBranchesLoading(true);
    setBranchError("");
    void remoteRequest<HostBranches>(machine.id, "git.branches", {
      projectId: project.projectId,
      cwd: executionCwd,
    })
      .then((value) => {
        if (!cancelled) {
          cachedBranches.set(
            branchKey(machine.id, project.projectId, executionCwd),
            value,
          );
          setBranches(value);
        }
      })
      .catch((reason) => {
        if (!cancelled) setBranchError(String(reason).replace(/^Error: /, ""));
      })
      .finally(() => {
        if (!cancelled) setBranchesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [online, machine.id, project.projectId, executionCwd, branchRefresh]);

  const providers = useMemo(
    () => (descriptor?.providers ?? []).filter(isRemoteProvider),
    [descriptor],
  );
  // A new session starts with the tab's model when the host offers it, and
  // otherwise with the host's first model.
  useEffect(() => {
    if (sessionId || !catalog || !providers.length) return;
    const harness = providers.includes(draft.harness)
      ? draft.harness
      : providers[0];
    const models = catalog.models[harness] ?? [];
    const model =
      findRemoteModel(models, draft.model) ??
      (harness === draft.harness ? undefined : models[0]) ??
      models[0];
    if (!model) return;
    if (harness === draft.harness && model.id === draft.model) return;
    setDraft((current) => ({
      ...current,
      harness,
      model: model.id,
      settings: carryModelSettings(model.settings ?? [], current.settings),
    }));
  }, [catalog, providers, sessionId, draft.harness, draft.model]);

  const saved: Configuration | undefined = hostSession && {
    harness: hostSession.harness as RemoteProvider,
    model: hostSession.model,
    settings: hostSession.modelSettings ?? {},
    mode: hostSession.runtimeMode,
  };
  const configuration = saved ? (changes ?? saved) : draft;
  const updateConfiguration = (
    update: (current: Configuration) => Configuration,
  ) => {
    if (saved) setChanges(update(changes ?? saved));
    else setDraft(update);
  };

  const selectedTurnModel = (): NonNullable<Block["turnModel"]> => ({
    harness: configuration.harness,
    id: configuration.model,
    name:
      findRemoteModel(
        catalog?.models[configuration.harness] ?? [],
        configuration.model,
      )?.name ?? configuration.model.replace(/^[^:]+:/, ""),
  });
  const optimisticTurn = (
    text: string,
    attachments: Attachment[] = [],
    intent: "default" | "plan" | "build" = "default",
    draft = false,
    draftBlockId?: string,
    planBlockId?: string,
  ): OptimisticTurn => ({
    commandId: crypto.randomUUID(),
    text,
    attachments,
    intent,
    draft,
    draftBlockId,
    planBlockId,
    startedAt: Date.now(),
    turnModel: selectedTurnModel(),
  });

  const run = async (
    command: HostCommand,
    optimistic?: OptimisticTurn,
  ): Promise<CommandReceipt | undefined> => {
    if (sendingRef.current) return undefined;
    sendingRef.current = true;
    setSending(true);
    setError("");
    if (command.type === "send" || command.type === "compact")
      setUnseenSend((current) =>
        current?.commandId === command.commandId
          ? current
          : {
              sessionId: command.sessionId,
              commandId: command.commandId,
              text: command.type === "send" ? command.text : "/compact",
              attachments: optimistic?.attachments ?? [],
              startedAt: optimistic?.startedAt ?? Date.now(),
              turnModel: optimistic?.turnModel ?? selectedTurnModel(),
              draftBlockId:
                command.type === "send" ? command.draftBlockId : undefined,
            },
      );
    // Keep the original ID across disconnects and app restarts. An ambiguous
    // response is retried explicitly instead of silently sending a new prompt.
    try {
      savePendingRemoteCommand(project.key, machine.environmentId, command);
      if (command.type !== "create") setPending(command);
      const receipt = await remoteRequest<CommandReceipt>(
        machine.id,
        "commands.dispatch",
        command,
      );
      clearPendingRemoteCommand(
        project.key,
        machine.environmentId,
        command.commandId,
      );
      if (!alive.current) return receipt;
      setPending(
        pendingRemoteCommand(
          project.key,
          machine.environmentId,
          command.type === "create" ? receipt.sessionId : (sessionId ?? null),
        ),
      );
      setRefresh((value) => value + 1);
      return receipt;
    } catch (reason) {
      if (!alive.current) return undefined;
      const message = String(reason);
      if (message.includes("Host rejected request:")) {
        if (command.type === "send" || command.type === "compact")
          setUnseenSend((current) =>
            current?.commandId === command.commandId ? undefined : current,
          );
        clearPendingRemoteCommand(
          project.key,
          machine.environmentId,
          command.commandId,
        );
        setPending(
          pendingRemoteCommand(
            project.key,
            machine.environmentId,
            sessionId ?? null,
          ),
        );
      }
      setError(message.replace(/^Error: /, ""));
      return undefined;
    } finally {
      sendingRef.current = false;
      if (alive.current) setSending(false);
    }
  };

  // A conversation that was only a draft goes with it, as a local one does,
  // and the tab starts over as a new conversation.
  const discardSession = async (id: string) => {
    try {
      await remoteRequest(machine.id, "sessions.delete", {
        projectId: project.projectId,
        sessionId: id,
      });
      cachedSessionSnapshots.delete(snapshotKey(machine.id, id));
      if (!alive.current) return;
      setSnapshot(undefined);
      rememberRemoteSession(shell.id);
    } catch (reason) {
      if (!alive.current) return;
      setRemovingDraft(undefined);
      setError(String(reason).replace(/^Error: /, ""));
    }
  };

  const openSession = (id: string) => {
    rememberRemoteSession(shell.id, id);
    setSessionId(id);
  };

  // Model, effort and permission changes apply directly, as locally. A
  // running turn keeps its settings; the change is sent once it finishes.
  const applying = useRef(false);
  // The last change the host accepted, until a sync reflects it.
  const applied = useRef<Configuration>(undefined);
  useEffect(() => {
    if (!changes || !saved || !hostSession) return;
    const same = (a: Configuration, b: Configuration) =>
      a.model === b.model &&
      a.mode === b.mode &&
      sameModelSettings(a.settings, b.settings);
    if (same(changes, saved)) {
      applied.current = undefined;
      setChanges(undefined);
      return;
    }
    if (applied.current && same(changes, applied.current)) return;
    if (busy || !online || pending || applying.current) return;
    applying.current = true;
    const sent = changes;
    void run({
      type: "configure",
      commandId: crypto.randomUUID(),
      sessionId: hostSession.id,
      model: changes.model,
      modelSettings: changes.settings,
      runtimeMode: changes.mode,
    })
      .then((receipt) => {
        if (receipt) applied.current = sent;
      })
      .finally(() => {
        applying.current = false;
      });
  });

  const dispatchTurn = async (
    id: string,
    turn: OptimisticTurn,
    uploaded?: RemoteAttachment[],
  ) => {
    const refs = turn.draftBlockId
      ? []
      : (uploaded ??
        (await uploadRemoteAttachments(machine.id, turn.attachments)));
    return run(
      turn.draft
        ? {
            type: "draft",
            commandId: turn.commandId,
            sessionId: id,
            text: turn.text,
            attachments: refs,
          }
        : message(
            id,
            turn.text,
            turn.commandId,
            refs,
            turn.intent,
            turn.draftBlockId,
            turn.planBlockId,
          ),
      turn,
    );
  };

  const startSession = async (turn: OptimisticTurn) => {
    try {
      const uploaded = await uploadRemoteAttachments(
        machine.id,
        turn.attachments,
      );
      let worktreeCwd = selectedCwd;
      let autoWorktreeBranch: string | undefined;
      if (draftWorkspaceMode === "worktree") {
        try {
          const tree = await remoteRequest<HostWorktree>(
            machine.id,
            "git.worktreeCreate",
            {
              projectId: project.projectId,
              cwd: selectedCwd,
              branch: temporaryWorktreeBranchName(),
              base: draftWorktreeBase,
              existing: false,
            },
          );
          worktreeCwd = tree.path;
          autoWorktreeBranch = tree.branch ?? undefined;
          rememberRemotePendingWorktree(shell.id, tree.path);
          if (alive.current) {
            setSelectedCwd(tree.path);
            setDraftWorkspaceMode("current");
          }
        } catch (reason) {
          if (alive.current) {
            setError(String(reason));
            setStarting({ ...turn, failed: true });
          }
          return;
        }
      }
      const receipt = await run({
        type: "create",
        commandId: crypto.randomUUID(),
        projectId: project.projectId,
        ...(worktreeCwd !== project.cwd ? { worktreeCwd } : {}),
        ...(autoWorktreeBranch ? { autoWorktreeBranch } : {}),
        harness: draft.harness,
        model: draft.model,
        modelSettings: draft.settings,
        runtimeMode: draft.mode,
      });
      if (!receipt) {
        if (alive.current) setStarting({ ...turn, failed: true });
        return;
      }
      if (alive.current) {
        openSession(receipt.sessionId);
      }
      const sent = await dispatchTurn(receipt.sessionId, turn, uploaded);
      if (alive.current)
        if (!sent) setStarting({ ...turn, failed: true });
    } catch (reason) {
      if (alive.current) {
        setError(String(reason));
        setStarting({ ...turn, failed: true });
      }
    } finally {
      preparingRef.current = false;
    }
  };

  const message = (
    id: string,
    text: string,
    commandId: string = crypto.randomUUID(),
    attachments: RemoteAttachment[] = [],
    intent: "default" | "plan" | "build" = "default",
    draftBlockId?: string,
    planBlockId?: string,
  ): HostCommand =>
    text.trim().toLowerCase() === "/compact" &&
    !attachments.length &&
    !draftBlockId &&
    intent === "default"
      ? { type: "compact", commandId, sessionId: id }
      : {
          type: "send",
          commandId,
          sessionId: id,
          text,
          attachments,
          intent,
          ...(draftBlockId ? { draftBlockId } : {}),
          ...(planBlockId ? { planBlockId } : {}),
        };

  const submit = (
    text: string,
    attachments: Attachment[] = [],
    options?: ComposerTurnOptions,
    asDraft = false,
    planBlockId?: string,
  ): boolean => {
    if (
      !online ||
      sending ||
      preparingRef.current ||
      pending ||
      busy ||
      (!text.trim() && !attachments.length)
    )
      return false;
    const intent =
      options?.intent === "plan" || options?.intent === "build"
        ? options.intent
        : "default";
    const turn = optimisticTurn(
      text,
      attachments,
      intent,
      asDraft,
      options?.draftBlockId,
      planBlockId,
    );
    preparingRef.current = true;
    setStarting(turn);
    if (!hostSession) {
      if (sessionId || !draft.model) {
        preparingRef.current = false;
        setStarting(undefined);
        return false;
      }
      void startSession(turn);
      return true;
    }
    if (changes) {
      preparingRef.current = false;
      setStarting(undefined);
      return false;
    }
    void dispatchTurn(hostSession.id, turn)
      .then((receipt) => {
        if (alive.current)
          if (!receipt) setStarting({ ...turn, failed: true });
      })
      .catch((reason) => {
        if (alive.current) {
          setError(String(reason));
          setStarting({ ...turn, failed: true });
        }
      })
      .finally(() => {
        preparingRef.current = false;
      });
    return true;
  };

  const inspect = async (method: "git.diff" | "files.read", path?: string) => {
    try {
      const text = await remoteRequest<string>(machine.id, method, {
        projectId: project.projectId,
        cwd: executionCwd,
        path,
      });
      if (alive.current)
        setPreview({
          title: path ?? `Changes on ${machine.name}`,
          text: text || "No tracked changes against HEAD.",
        });
    } catch (reason) {
      if (alive.current) setError(String(reason));
    }
  };

  const modelSource = useMemo<ModelSource>(() => {
    const models = (harness: HarnessId) =>
      catalog?.models[harness as RemoteProvider] ?? [];
    const savedModel = hostSession?.model;
    const savedSettings = hostSession?.modelSettings ?? {};
    return {
      id: `remote:${machine.environmentId}`,
      modelsFor: models,
      resolve: (harness, id = "") => {
        const provider = harness === "claude" ? "claude" : "codex";
        // Keep the saved model's effort visible even when the host catalog is
        // loading, failed, or no longer lists it.
        const controls = remoteModelControls(
          catalog,
          provider,
          id,
          id === savedModel ? savedSettings : {},
          savedModel,
        );
        const listed = controls.model;
        return {
          ...(listed ?? {
            id,
            harness,
            name: id ? id.replace(/^[a-z]+:/, "") : "Loading models…",
            nativeId: id.replace(/^[a-z]+:/, ""),
          }),
          settings: controls.settings,
        } satisfies AgentModel;
      },
      find: (id) =>
        providers
          .flatMap((harness) => models(harness))
          .find((m) => m.id === id),
      available: (harness) =>
        providers.includes(harness as RemoteProvider) &&
        (!hostSession || hostSession.harness === harness),
      probed: () => !!descriptor,
      refresh: () => {
        if (!catalog || catalogError || Object.keys(catalog.errors).length)
          setCatalogRefresh((value) => value + 1);
      },
    };
  }, [
    catalog,
    catalogError,
    descriptor,
    providers,
    machine.environmentId,
    hostSession?.harness,
    hostSession?.model,
    hostSession?.modelSettings,
  ]);

  // Show a message the host has not confirmed yet in the transcript.
  // A draft being sent is replaced by its message at once, as locally.
  const leavingDrafts = new Set(
    [
      removingDraft,
      startingActive ? starting?.draftBlockId : undefined,
      pendingSendActive && pending?.type === "send"
        ? pending.draftBlockId
        : undefined,
      unseenActive ? unseenSend?.draftBlockId : undefined,
    ].filter(Boolean),
  );
  const blocks: Block[] = (hostSession?.blocks ?? []).filter(
    (block) => !leavingDrafts.has(block.id),
  );
  const unconfirmed: Block | undefined =
    unseenActive && unseenSend
      ? {
          id: unseenSend.commandId,
          role: "user",
          text: unseenSend.text,
          attachments: unseenSend.attachments,
          startedAt: unseenSend.startedAt,
          turnModel: unseenSend.turnModel,
        }
      : pendingSendActive && pending
        ? {
            id: pending.commandId,
            role: "user",
            text: pending.type === "send" ? pending.text : "/compact",
          }
        : startingActive && starting
          ? {
              id: starting.commandId,
              role: "user",
              text: starting.text,
              attachments: starting.attachments,
              draft: starting.draft,
              startedAt: starting.startedAt,
              turnModel: starting.turnModel,
            }
          : undefined;
  const session: Session = {
    ...(hostSession ?? {
      title: shell.title,
      blocks: [],
    }),
    id: shell.id,
    cwd: executionCwd,
    harness: configuration.harness,
    model: configuration.model,
    modelSettings: configuration.settings,
    runtimeMode: configuration.mode,
    busy,
    blocks: unconfirmed ? [...blocks, unconfirmed] : blocks,
  };

  const catalogProblem = catalog?.errors[configuration.harness] ?? catalogError;
  const notice = connectionError
    ? { text: `Reconnecting to ${machine.name}…`, detail: connectionError }
    : starting?.failed
      ? {
          text: `Couldn’t ${starting.draft ? "save the draft" : "send the message"} on ${machine.name}.`,
          detail: error,
          action: {
            label: "Try again",
            run: () => {
              const turn = starting;
              setStarting(turn);
              preparingRef.current = true;
              if (!sessionId) void startSession(turn);
              else
                void dispatchTurn(sessionId, turn)
                  .then((sent) => {
                    if (alive.current)
                      if (!sent) setStarting({ ...turn, failed: true });
                  })
                  .catch((reason) => {
                    if (alive.current) {
                      setError(String(reason));
                      setStarting({ ...turn, failed: true });
                    }
                  })
                  .finally(() => {
                    preparingRef.current = false;
                  });
            },
          },
        }
      : pending && pending.type !== "create"
        ? {
            text: "Waiting for the host to confirm your request.",
            detail: error,
            action: {
              label: sending ? "Sending…" : "Retry",
              run: () => void run(pending),
            },
          }
        : error
          ? {
              text: error,
              action: { label: "Dismiss", run: () => setError("") },
            }
          : catalogProblem
            ? {
                text: `Couldn’t load models from ${machine.name}.`,
                detail: catalogProblem,
                action: {
                  label: "Retry",
                  run: () => setCatalogRefresh((value) => value + 1),
                },
              }
            : undefined;

  const remoteHost = (
    <RemoteHostBar
      machine={machine}
      project={project}
      cwd={executionCwd}
      online={online}
      branches={branches}
      branchesLoading={branchesLoading}
      branchError={branchError}
      switching={switchingBranch}
      busy={busy || (!!sessionId && !hostSession)}
      allowNewWorktree={!hostSession && !sessionId}
      workspaceMode={draftWorkspaceMode}
      worktreeBase={
        draftWorktreeBase === "HEAD" && branches?.current
          ? branches.current
          : draftWorktreeBase
      }
      onWorkspaceModeChange={(mode) => {
        setDraftWorkspaceMode(mode);
        if (
          mode === "worktree" &&
          draftWorktreeBase === "HEAD" &&
          branches?.current
        )
          setDraftWorktreeBase(branches.current);
      }}
      onWorktreeBaseChange={setDraftWorktreeBase}
      onSelectWorktree={async (tree) => {
        if (tree.path === executionCwd) return;
        if (!hostSession) {
          rememberRemotePendingWorktree(shell.id, tree.path);
          setSelectedCwd(tree.path);
          return;
        }
        if (!onOpenWorktree)
          throw new Error("Cannot open another remote session here");
        onOpenWorktree(shell.cwd, tree.path, {
          harness: configuration.harness,
          model: configuration.model,
          modelSettings: configuration.settings,
          runtimeMode: configuration.mode,
        });
      }}
      onBranchAction={async (method, branch, remote) => {
        setSwitchingBranch(true);
        setError("");
        try {
          const value = await remoteRequest<HostBranches>(machine.id, method, {
            projectId: project.projectId,
            cwd: executionCwd,
            branch,
            remote,
          });
          if (alive.current) {
            cachedBranches.set(
              branchKey(machine.id, project.projectId, executionCwd),
              value,
            );
            setBranches(value);
          }
        } catch (reason) {
          if (alive.current) setError(String(reason));
          throw reason;
        } finally {
          if (alive.current) setSwitchingBranch(false);
          setBranchRefresh((value) => value + 1);
        }
      }}
      onReloadBranches={() => setBranchRefresh((value) => value + 1)}
    />
  );

  const overrides: RemoteSessionOverrides = {
    session,
    remoteHost,
    remoteFeatures: {
      attachments: !!descriptor?.capabilities.includes("attachments.upload"),
      plan: !!descriptor?.capabilities.includes("sessions.plan"),
      draft: !!descriptor?.capabilities.includes("sessions.draft"),
    },
    remoteSessionLoading: !!sessionId && !hostSession && !session.blocks.length,
    allowedModelHarnesses: hostSession
      ? [hostSession.harness]
      : providers.length
        ? providers
        : ["codex", "claude"],
    onSubmit: (_, text, attachments, options) =>
      submit(text, attachments, options),
    onStop: () => {
      if (hostSession?.busy && snapshot?.runId)
        void run({
          type: "cancel",
          commandId: crypto.randomUUID(),
          sessionId: hostSession.id,
          runId: snapshot.runId,
        });
    },
    onApproval: (_, requestId, decision) => {
      if (!hostSession || !snapshot?.runId) return;
      void run({
        type: "approve",
        commandId: crypto.randomUUID(),
        sessionId: hostSession.id,
        runId: snapshot.runId,
        requestId,
        decision,
      });
    },
    onQuestionReply: (_, requestId, reply) => {
      if (!hostSession || !snapshot?.runId) return;
      void run({
        type: "answer",
        commandId: crypto.randomUUID(),
        sessionId: hostSession.id,
        runId: snapshot.runId,
        requestId,
        reply,
      });
    },
    onCompactContext: () => {
      if (!hostSession || busy || pending || changes || !online) return false;
      void run(message(hostSession.id, "/compact"));
      return true;
    },
    onModelChange: (_, harness, model) => {
      if (!isRemoteProvider(harness)) return;
      updateConfiguration((current) => ({
        ...current,
        harness,
        model,
        settings: carryModelSettings(
          modelSource.resolve(harness, model).settings ?? [],
          current.settings,
        ),
      }));
    },
    onModelSettingsChange: (_, settings) =>
      updateConfiguration((current) => ({ ...current, settings })),
    onRuntimeModeChange: (_, mode) =>
      updateConfiguration((current) => ({ ...current, mode })),
    onOpenFile: (path) => void inspect("files.read", path),
    onOpenDiff: () => void inspect("git.diff"),
    // This computer's features do not apply to a host session.
    onCwdChange: noop,
    onBranchChange: noop,
    onWorktreeChange: undefined,
    onWorkspaceModeChange: noop,
    onWorktreeBaseChange: noop,
    onManageWorktrees: undefined,
    onSaveDraft: (_, text, attachments) =>
      submit(text, attachments, undefined, true),
    onRemoveDraft: (_, draftBlockId) => {
      if (!hostSession || busy || pending || !online || removingDraft)
        return false;
      setRemovingDraft(draftBlockId);
      if (hostSession.blocks.every((block) => block.id === draftBlockId))
        void discardSession(hostSession.id);
      else
        void run({
          type: "removeDraft",
          commandId: crypto.randomUUID(),
          sessionId: hostSession.id,
          draftBlockId,
        }).then((receipt) => {
          if (!receipt && alive.current) setRemovingDraft(undefined);
        });
      return true;
    },
    onPlaceSessionInFolder: noop,
    onDeleteQueuedMessage: noop,
    onEditQueuedMessage: noop,
    onQueuedMessageEditingChange: noop,
    onSteerQueuedMessage: noop,
    onResumeQueue: noop,
    onUsageLimitResume: noop,
    onUsageLimitResumeAtReset: noop,
    onUsageLimitDismiss: noop,
    onOpenPlan: (_, blockId) => {
      const block = hostSession?.blocks.find(
        (entry) => entry.id === blockId && entry.role === "plan",
      );
      if (block) setPreview({ title: "Plan", text: block.text });
    },
    onBuildPlan: (_, blockId, target) => {
      const block = hostSession?.blocks.find(
        (entry) => entry.id === blockId && entry.role === "plan",
      );
      if (!block || !block.text.trim() || block.streaming || busy) return;
      if (
        target &&
        (target.harness !== configuration.harness ||
          target.model !== configuration.model ||
          !sameModelSettings(target.modelSettings, configuration.settings))
      ) {
        setError(
          "Select that model in the composer before building this remote plan.",
        );
        return;
      }
      submit(
        `Build the approved plan:\n\n${block.text}`,
        [],
        {
          intent: "build",
        },
        false,
        blockId,
      );
    },
    onSecondOpinion: undefined,
    onHandoff: undefined,
    onBtwSubmit: undefined,
    onBtwRetry: undefined,
    onBtwDelete: undefined,
    onBtwModelChange: undefined,
    onNewTerminal: noop,
    onArchiveSession: undefined,
    onDeleteSession: undefined,
    reviewUndoLocked: true,
  };

  return (
    <ModelSourceContext.Provider value={modelSource}>
      <div className="relative flex h-full min-h-0 flex-col">
        {notice ? (
          <div
            role={connectionError || error ? "alert" : "status"}
            className="flex shrink-0 items-center gap-3 border-b border-stroke px-4 py-2 text-[12px] text-content/65"
          >
            <span className="min-w-0 flex-1 truncate" title={notice.detail}>
              {notice.text}
              {notice.detail ? (
                <span className="text-content/40"> {notice.detail}</span>
              ) : null}
            </span>
            {notice.action ? (
              <button
                type="button"
                disabled={!online && notice.action.label !== "Dismiss"}
                className="shrink-0 rounded-md px-2 py-1 text-content/70 hover:bg-content/8 hover:text-content disabled:opacity-40"
                onClick={notice.action.run}
              >
                {notice.action.label}
              </button>
            ) : null}
          </div>
        ) : null}
        <div className="min-h-0 flex-1">{render(overrides)}</div>
        {preview ? (
          <div className="absolute inset-0 z-40 flex flex-col bg-background-base">
            <div className="flex h-10 shrink-0 items-center gap-2 border-b border-stroke px-4 text-[12px]">
              <span className="min-w-0 flex-1 truncate font-mono text-content/70">
                {preview.title}
              </span>
              <button
                type="button"
                aria-label="Close preview"
                className="grid size-6 place-items-center rounded-md text-content/50 hover:bg-content/8 hover:text-content"
                onClick={() => setPreview(undefined)}
              >
                <X className="size-3.5" />
              </button>
            </div>
            <pre className="min-h-0 flex-1 overflow-auto p-4 font-mono text-[12px] leading-5 whitespace-pre-wrap text-content/80">
              {preview.text}
            </pre>
          </div>
        ) : null}
      </div>
    </ModelSourceContext.Provider>
  );
}

/** The composer's top row for a remote session: which checkout and host
 * branch it runs in, in the same style as the local branch picker. The
 * machine and its connection state are shown in the project rail. */
function RemoteHostBar({
  machine,
  project,
  cwd,
  online,
  branches,
  branchesLoading,
  branchError,
  switching,
  busy,
  allowNewWorktree,
  workspaceMode,
  worktreeBase,
  onWorkspaceModeChange,
  onWorktreeBaseChange,
  onSelectWorktree,
  onBranchAction,
  onReloadBranches,
}: {
  machine: RemoteMachine;
  project: RemoteProject;
  cwd: string;
  online: boolean;
  branches?: HostBranches;
  branchesLoading: boolean;
  branchError: string;
  switching: boolean;
  busy: boolean;
  allowNewWorktree: boolean;
  workspaceMode: WorkspaceMode;
  worktreeBase: string;
  onWorkspaceModeChange: (mode: WorkspaceMode) => void;
  onWorktreeBaseChange: (base: string) => void;
  onSelectWorktree: (tree: HostWorktree) => Promise<void>;
  onBranchAction: (
    method: "git.switch" | "git.createBranch",
    branch: string,
    remote?: string,
  ) => Promise<void>;
  onReloadBranches: () => void;
}) {
  const anchor = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [pickerError, setPickerError] = useState("");
  const [active, setActive] = useState(0);
  const [actionBusy, setActionBusy] = useState(false);
  const canSwitch = online && !busy && !switching;
  const branchLabel = switching
    ? "Switching…"
    : branchError
      ? /not a git repository/i.test(branchError)
        ? "No repo"
        : "Branch unavailable"
      : branches?.current
        ? branches.current
        : branches
          ? "Detached"
          : branchesLoading
            ? "Loading…"
            : "Branch";
  const filtered = [
    ...(branches?.branches.map((name) => ({
      name,
      remote: null as string | null,
    })) ?? []),
    ...(branches?.remotes ?? []),
  ].filter((branch) =>
    `${branch.remote ? `${branch.remote}/` : ""}${branch.name}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const createName = query.trim();
  const canCreate = !branches?.branches.includes(createName);
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => search.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);
  const runBranchAction = async (
    method: "git.switch" | "git.createBranch",
    branch: string,
    remote?: string,
  ) => {
    if (actionBusy) return;
    setActionBusy(true);
    setPickerError("");
    try {
      await onBranchAction(method, branch, remote);
      setOpen(false);
      setCreating(false);
      setQuery("");
    } catch (reason) {
      setPickerError(String(reason).replace(/^Error: /, ""));
    } finally {
      setActionBusy(false);
    }
  };
  return (
    <>
      <RemoteWorktreePicker
        machine={machine}
        project={project}
        cwd={cwd}
        branches={branches}
        mode={workspaceMode}
        base={worktreeBase}
        online={online}
        busy={busy}
        allowNewWorktree={allowNewWorktree}
        onSelect={onSelectWorktree}
        onModeChange={onWorkspaceModeChange}
        onBaseChange={onWorktreeBaseChange}
      />
      {workspaceMode === "current" ? (
        <div ref={anchor} className="relative flex min-w-0 shrink-0">
          <GitPickerTrigger
            loading={!branches && !branchError}
            dimWhenDisabled={false}
            title={
              busy
                ? "Wait for the turn to finish to switch branches"
                : branchError || "Choose a branch on the host"
            }
            aria-label={`Host branch ${branchLabel}`}
            aria-expanded={open}
            aria-haspopup="dialog"
            disabled={!canSwitch}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              setOpen((value) => !value);
              setCreating(false);
              setQuery("");
              setPickerError("");
              setActive(0);
            }}
            label={branchLabel}
          />
          {open ? (
            <Popover
              anchor={anchor}
              side="top"
              align="start"
              width={280}
              minHeight={180}
              maxHeight={280}
              constrainHeight
              onDismiss={() => {
                if (!actionBusy) setOpen(false);
              }}
              role="dialog"
              aria-label="Host branches"
              data-branch-picker
              className="flex flex-col overflow-hidden"
            >
              {branchesLoading && !branches ? (
                <p className="p-3 text-[12px] text-content/50">
                  Loading branches…
                </p>
              ) : branchError || !branches ? (
                <div className="flex flex-col gap-2 p-3 text-[12px]">
                  <p
                    role={branchError ? "alert" : "status"}
                    className="text-content/60"
                  >
                    {branchError || "Branch information is unavailable."}
                  </p>
                  <button
                    type="button"
                    onClick={onReloadBranches}
                    className="self-start rounded-md px-2 py-1 text-content/75 hover:bg-content/8"
                  >
                    Retry
                  </button>
                </div>
              ) : (
                <>
                  <label className="flex items-center gap-2 border-b border-stroke px-3 py-2.5 text-content/50">
                    <Search className="size-3.5 text-content/40" />
                    <input
                      ref={search}
                      aria-label="Search or create a host branch"
                      placeholder="Search or create a branch..."
                      value={query}
                      disabled={actionBusy}
                      onChange={(event) => {
                        setQuery(event.target.value);
                        setActive(0);
                        setPickerError("");
                      }}
                      onKeyDown={(event) => {
                        if (
                          event.key === "ArrowDown" ||
                          event.key === "ArrowUp"
                        ) {
                          event.preventDefault();
                          setActive((value) =>
                            Math.max(
                              0,
                              Math.min(
                                filtered.length - 1,
                                value + (event.key === "ArrowDown" ? 1 : -1),
                              ),
                            ),
                          );
                        }
                        if (event.key === "Enter") {
                          event.preventDefault();
                          const choice = filtered[active];
                          if (choice) {
                            if (
                              choice.remote ||
                              choice.name !== branches.current
                            )
                              void runBranchAction(
                                "git.switch",
                                choice.name,
                                choice.remote ?? undefined,
                              );
                            else setOpen(false);
                          } else if (createName && canCreate) {
                            void runBranchAction(
                              "git.createBranch",
                              createName,
                            );
                          }
                        }
                      }}
                      className="min-w-0 flex-1 bg-transparent text-[13px] text-content outline-none placeholder:text-content/40 disabled:opacity-60"
                    />
                  </label>
                  <div
                    role="listbox"
                    aria-label="Host branches"
                    className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5"
                  >
                    {filtered.map((branch, index) => {
                      const selected =
                        !branch.remote && branch.name === branches.current;
                      return (
                        <button
                          key={`${branch.remote ?? "local"}:${branch.name}`}
                          type="button"
                          role="option"
                          aria-selected={selected}
                          disabled={actionBusy}
                          onMouseDown={(event) => event.preventDefault()}
                          onMouseEnter={() => setActive(index)}
                          className={`flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] disabled:opacity-60 ${active === index || selected ? "bg-selection text-content" : "text-content hover:bg-content/5"}`}
                          onClick={() => {
                            if (branch.remote || !selected)
                              void runBranchAction(
                                "git.switch",
                                branch.name,
                                branch.remote ?? undefined,
                              );
                            else setOpen(false);
                          }}
                        >
                          {selected ? (
                            <Check className="size-3.5 shrink-0" />
                          ) : (
                            <GitBranch className="size-3.5 shrink-0 text-content/50" />
                          )}
                          <span
                            className={`min-w-0 flex-1 truncate ${selected ? "font-medium" : ""}`}
                          >
                            {branch.name}
                          </span>
                          {branch.remote ? (
                            <span className="shrink-0 rounded bg-content/6 px-1.5 py-0.5 text-[10px] text-content/40">
                              {branch.remote}
                            </span>
                          ) : null}
                        </button>
                      );
                    })}
                    {!filtered.length ? (
                      <p className="p-2 text-[12px] text-content/50">
                        No matching branches
                      </p>
                    ) : null}
                  </div>
                  {pickerError ? (
                    <p
                      role="alert"
                      className="max-h-16 overflow-y-auto whitespace-pre-wrap border-t border-stroke px-2.5 py-2 text-[11px] leading-4 text-red-400/90"
                    >
                      {pickerError}
                    </p>
                  ) : null}
                  {canCreate ? (
                    <div className="border-t border-stroke p-1 px-1.5">
                      <button
                        type="button"
                        disabled={actionBusy}
                        onClick={() => {
                          if (createName)
                            void runBranchAction(
                              "git.createBranch",
                              createName,
                            );
                          else {
                            setOpen(false);
                            setCreating(true);
                          }
                        }}
                        className="flex h-7.5 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] text-content/75 hover:bg-content/8 hover:text-content disabled:opacity-60"
                      >
                        <Plus className="size-4 shrink-0" />
                        {createName
                          ? `Create and checkout ${createName}`
                          : "New branch"}
                      </button>
                    </div>
                  ) : null}
                </>
              )}
            </Popover>
          ) : null}
          {creating ? (
            <CreateBranchDialog
              busy={actionBusy}
              error={pickerError}
              onCreate={(name) =>
                void runBranchAction("git.createBranch", name)
              }
              onCancel={() => {
                if (!actionBusy) {
                  setCreating(false);
                  setPickerError("");
                }
              }}
            />
          ) : null}
        </div>
      ) : null}
    </>
  );
}
