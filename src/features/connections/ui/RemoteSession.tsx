import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { SessionPaneProps } from "../../sessions/ui/SessionPane";
import type {
  Block,
  HarnessId,
  RuntimeMode,
  Session,
} from "../../sessions/model/session";
import type { AgentModel } from "../../sessions/model/models";
import {
  ModelSourceContext,
  type ModelSource,
} from "../../sessions/ui/modelSource";
import { GitPickerTrigger } from "../../source-control/ui/GitPickerTrigger";
import { Popover } from "../../../shared/ui/Popover";
import { Check, Globe, Plus, Search, X } from "../../../shared/ui/icons";
import {
  clearPendingRemoteCommand,
  loadRemoteSession,
  OPEN_CONNECTIONS_EVENT,
  pendingRemoteCommand,
  rememberRemotePendingWorktree,
  rememberRemoteSession,
  remoteRequest,
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
  type RemoteMachine,
  type RemoteProvider,
} from "../model/protocol";
import { RemoteWorktreePicker } from "./RemoteWorktreePicker";

export type RemoteSessionOverrides = Partial<SessionPaneProps> & {
  remoteHost: ReactNode;
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

/** A tab in a project on another machine. The host owns the session; this
 * renders the normal session pane with actions routed to the host. */
export function RemoteSession({
  shell,
  visible,
  onOpenWorktree,
  render,
}: {
  /** The tab's local session, which provides its ID and new-session defaults. */
  shell: Session;
  visible: boolean;
  onOpenWorktree?: SessionPaneProps["onOpenRemoteWorktree"];
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
  machine,
  project,
  render,
}: {
  shell: Session;
  visible: boolean;
  onOpenWorktree?: SessionPaneProps["onOpenRemoteWorktree"];
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
  const [switchingBranch, setSwitchingBranch] = useState(false);
  const [preview, setPreview] = useState<{ title: string; text: string }>();
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [unseenSend, setUnseenSend] = useState<
    OptimisticTurn & { sessionId: string }
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
        setConnectionError("");
        // A catalog request that failed while offline is retried on recovery.
        if (failed) setCatalogRefresh((value) => value + 1);
        failed = 0;
        if (next && sessionId)
          rememberSessionSnapshot(snapshotKey(machine.id, sessionId), next);
        setSnapshot(next);
        active = !!next?.session.busy;
      } catch (reason) {
        if (disposed) return;
        setOnline(false);
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
  const optimisticTurn = (text: string): OptimisticTurn => ({
    commandId: crypto.randomUUID(),
    text,
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
              startedAt: optimistic?.startedAt ?? Date.now(),
              turnModel: optimistic?.turnModel ?? selectedTurnModel(),
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

  const startSession = async (turn: OptimisticTurn) => {
    const receipt = await run({
      type: "create",
      commandId: crypto.randomUUID(),
      projectId: project.projectId,
      ...(selectedCwd !== project.cwd ? { worktreeCwd: selectedCwd } : {}),
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
    const sent = await run(
      message(receipt.sessionId, turn.text, turn.commandId),
      turn,
    );
    if (alive.current)
      setStarting(sent ? undefined : { ...turn, failed: true });
  };

  const message = (
    id: string,
    text: string,
    commandId: string = crypto.randomUUID(),
  ): HostCommand =>
    text.trim().toLowerCase() === "/compact"
      ? { type: "compact", commandId, sessionId: id }
      : { type: "send", commandId, sessionId: id, text };

  const submit = (text: string): boolean => {
    if (!online || sending || pending || busy || !text.trim()) return false;
    if (!hostSession) {
      if (sessionId || !draft.model) return false;
      const turn = optimisticTurn(text);
      setStarting(turn);
      void startSession(turn);
      return true;
    }
    if (changes) return false;
    void run(message(hostSession.id, text));
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
  const blocks: Block[] = hostSession?.blocks ?? [];
  const unconfirmed: Block | undefined =
    unseenActive && unseenSend
      ? {
          id: unseenSend.commandId,
          role: "user",
          text: unseenSend.text,
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
          text: `Couldn’t start the session on ${machine.name}.`,
          detail: error,
          action: {
            label: "Try again",
            run: () => {
              const turn = optimisticTurn(starting.text);
              setStarting(turn);
              void (sessionId
                ? run(message(sessionId, turn.text, turn.commandId), turn).then(
                    (sent) =>
                      setStarting(sent ? undefined : { ...turn, failed: true }),
                  )
                : startSession(turn));
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
      onBranchAction={(method, branch, remote) => {
        setSwitchingBranch(true);
        setError("");
        void remoteRequest<HostBranches>(machine.id, method, {
          projectId: project.projectId,
          cwd: executionCwd,
          branch,
          remote,
        })
          .then((value) => {
            if (alive.current) {
              cachedBranches.set(
                branchKey(machine.id, project.projectId, executionCwd),
                value,
              );
              setBranches(value);
            }
          })
          .catch((reason) => {
            if (alive.current) setError(String(reason));
          })
          .finally(() => {
            if (alive.current) setSwitchingBranch(false);
            setBranchRefresh((value) => value + 1);
          });
      }}
      onReloadBranches={() => setBranchRefresh((value) => value + 1)}
    />
  );

  const overrides: RemoteSessionOverrides = {
    session,
    remoteHost,
    allowedModelHarnesses: hostSession
      ? [hostSession.harness]
      : providers.length
        ? providers
        : ["codex", "claude"],
    onSubmit: (_, text) => submit(text),
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
    onSaveDraft: () => false,
    onRemoveDraft: () => false,
    onPlaceSessionInFolder: noop,
    onDeleteQueuedMessage: noop,
    onEditQueuedMessage: noop,
    onQueuedMessageEditingChange: noop,
    onSteerQueuedMessage: noop,
    onResumeQueue: noop,
    onUsageLimitResume: noop,
    onUsageLimitResumeAtReset: noop,
    onUsageLimitDismiss: noop,
    onOpenPlan: noop,
    onBuildPlan: noop,
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

/** The composer's top row for a remote session: where it runs and on which
 * host branch, in the same style as the local project and branch pickers. */
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
  onSelectWorktree: (tree: HostWorktree) => Promise<void>;
  onBranchAction: (
    method: "git.switch" | "git.createBranch",
    branch: string,
    remote?: string,
  ) => void;
  onReloadBranches: () => void;
}) {
  const anchor = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
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
  return (
    <>
      <span
        className="flex min-w-0 max-w-44 shrink items-center gap-1.5 text-content/50"
        title={`${machine.name} · ${project.cwd}`}
      >
        <span className="relative shrink-0">
          <Globe className="size-3.5" strokeWidth={1.5} />
          <span
            aria-hidden
            className={`absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full ring-1 ring-background-base ${
              online ? "bg-emerald-400" : "bg-content/35"
            }`}
          />
        </span>
        <span className="truncate font-mono text-[12px]">{machine.name}</span>
        <span className="sr-only">{online ? "Connected" : "Reconnecting"}</span>
      </span>
      <RemoteWorktreePicker
        machine={machine}
        project={project}
        cwd={cwd}
        branches={branches}
        online={online}
        busy={busy}
        onSelect={onSelectWorktree}
      />
      <div ref={anchor} className="relative flex min-w-0 shrink-0">
        <GitPickerTrigger
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
          }}
          label={branchLabel}
        />
        {open ? (
          <Popover
            anchor={anchor}
            side="top"
            align="start"
            width={240}
            maxHeight={280}
            constrainHeight
            onDismiss={() => setOpen(false)}
            role="dialog"
            aria-label="Host branches"
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
            ) : creating ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!name.trim()) return;
                  setOpen(false);
                  onBranchAction("git.createBranch", name.trim());
                }}
                className="flex flex-col gap-2 p-3 text-[12px]"
              >
                <label htmlFor="remote-new-branch">New branch name</label>
                <input
                  id="remote-new-branch"
                  aria-label="New remote branch"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="feature/my-task"
                  className="rounded-md border border-content/10 bg-background-base p-2 outline-none"
                />
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setCreating(false)}
                    className="rounded-md px-2 py-1 hover:bg-content/8"
                  >
                    Back
                  </button>
                  <button
                    type="submit"
                    disabled={!name.trim()}
                    className="rounded-md bg-content px-2 py-1 text-background-base disabled:opacity-40"
                  >
                    Create branch
                  </button>
                </div>
              </form>
            ) : (
              <>
                <label className="flex items-center gap-2 border-b border-stroke px-3 py-2">
                  <Search className="size-3.5 text-content/40" />
                  <input
                    aria-label="Search host branches"
                    placeholder="Search branches…"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    className="min-w-0 flex-1 bg-transparent text-[12px] outline-none"
                  />
                </label>
                <div className="min-h-0 overflow-y-auto p-1">
                  {filtered.map((branch) => (
                    <button
                      key={`${branch.remote ?? "local"}:${branch.name}`}
                      type="button"
                      role="menuitemradio"
                      aria-checked={
                        !branch.remote && branch.name === branches.current
                      }
                      className="flex h-7.5 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[13px] text-content/75 hover:bg-content/8 hover:text-content"
                      onClick={() => {
                        setOpen(false);
                        if (branch.remote || branch.name !== branches.current)
                          onBranchAction(
                            "git.switch",
                            branch.name,
                            branch.remote ?? undefined,
                          );
                      }}
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {branch.remote ? `${branch.remote}/` : ""}
                        {branch.name}
                      </span>
                      {!branch.remote && branch.name === branches.current ? (
                        <Check className="size-3.5 shrink-0 text-content/55" />
                      ) : null}
                    </button>
                  ))}
                  {!filtered.length ? (
                    <p className="p-2 text-[12px] text-content/50">
                      No matching branches
                    </p>
                  ) : null}
                </div>
                <div className="border-t border-stroke p-1">
                  <button
                    type="button"
                    onClick={() => {
                      setCreating(true);
                      setName(query);
                    }}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-[12px] hover:bg-content/8"
                  >
                    <Plus className="size-3.5" />
                    Create branch…
                  </button>
                </div>
              </>
            )}
          </Popover>
        ) : null}
      </div>
    </>
  );
}
