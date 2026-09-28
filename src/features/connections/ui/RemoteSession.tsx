import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
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
import { Check, Globe, X } from "../../../shared/ui/icons";
import {
  clearPendingRemoteCommand,
  loadRemoteSession,
  OPEN_CONNECTIONS_EVENT,
  pendingRemoteCommand,
  rememberRemoteSession,
  remoteRequest,
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
  type RemoteMachine,
  type RemoteProvider,
} from "../model/protocol";

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

const noop = () => {};

/** A tab in a project on another machine. The host owns the session; this
 * renders the normal session pane with actions routed to the host. */
export function RemoteSession({
  shell,
  visible,
  render,
}: {
  /** The tab's local session, which provides its ID and new-session defaults. */
  shell: Session;
  visible: boolean;
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
      machine={machine}
      project={project}
      render={render}
    />
  );
}

function ConnectedRemoteSession({
  shell,
  visible,
  machine,
  project,
  render,
}: {
  shell: Session;
  visible: boolean;
  machine: RemoteMachine;
  project: RemoteProject;
  render: (overrides: RemoteSessionOverrides) => ReactNode;
}) {
  const [descriptor, setDescriptor] = useState<HostDescriptor>();
  const [online, setOnline] = useState(false);
  const [connectionError, setConnectionError] = useState("");
  const [error, setError] = useState("");
  const [sessionId, setSessionId] = useState(() => remoteSessionFor(shell.id));
  const [snapshot, setSnapshot] = useState<HostSession>();
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const [refresh, setRefresh] = useState(0);
  const [catalog, setCatalog] = useState<HostModelCatalog>();
  const [catalogError, setCatalogError] = useState("");
  const [catalogRefresh, setCatalogRefresh] = useState(0);
  const [branches, setBranches] = useState<HostBranches>();
  const [switchingBranch, setSwitchingBranch] = useState(false);
  const [preview, setPreview] = useState<{ title: string; text: string }>();
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  // A first message waits here while its session is created on the host.
  const [starting, setStarting] = useState<{
    text: string;
    failed?: boolean;
  }>();
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
  const busy = !!hostSession?.busy || (!!starting && !starting.failed);

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

  const loadBranches = useCallback(() => {
    void remoteRequest<HostBranches>(machine.id, "git.branches", {
      projectId: project.projectId,
    })
      .then((value) => {
        if (alive.current) setBranches(value);
      })
      .catch(() => {
        if (alive.current) setBranches(undefined);
      });
  }, [machine.id, project.projectId]);
  useEffect(() => {
    if (online) loadBranches();
  }, [online, loadBranches]);

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

  const run = async (
    command: HostCommand,
  ): Promise<CommandReceipt | undefined> => {
    if (sendingRef.current) return undefined;
    sendingRef.current = true;
    setSending(true);
    setError("");
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

  const startSession = async (text: string) => {
    const receipt = await run({
      type: "create",
      commandId: crypto.randomUUID(),
      projectId: project.projectId,
      harness: draft.harness,
      model: draft.model,
      modelSettings: draft.settings,
      runtimeMode: draft.mode,
    });
    if (!receipt) {
      if (alive.current) setStarting({ text, failed: true });
      return;
    }
    if (alive.current) openSession(receipt.sessionId);
    const sent = await run(message(receipt.sessionId, text));
    if (alive.current) setStarting(sent ? undefined : { text, failed: true });
  };

  const message = (id: string, text: string): HostCommand =>
    text.trim().toLowerCase() === "/compact"
      ? { type: "compact", commandId: crypto.randomUUID(), sessionId: id }
      : { type: "send", commandId: crypto.randomUUID(), sessionId: id, text };

  const submit = (text: string): boolean => {
    if (!online || sending || pending || busy || !text.trim()) return false;
    if (!hostSession) {
      if (sessionId || !draft.model) return false;
      setStarting({ text });
      void startSession(text);
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
  const unconfirmed =
    pending?.type === "send" &&
    pending.sessionId === hostSession?.id &&
    !blocks.some((block) => block.id === pending.commandId)
      ? pending.text
      : !hostSession && starting
        ? starting.text
        : undefined;
  const session: Session = {
    ...(hostSession ?? {
      title: shell.title,
      blocks: [],
    }),
    id: shell.id,
    cwd: project.cwd,
    harness: configuration.harness,
    model: configuration.model,
    modelSettings: configuration.settings,
    runtimeMode: configuration.mode,
    busy,
    blocks: unconfirmed
      ? [...blocks, { id: "unconfirmed", role: "user", text: unconfirmed }]
      : blocks,
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
              const text = starting.text;
              setStarting({ text });
              void (sessionId
                ? run(message(sessionId, text)).then((sent) =>
                    setStarting(sent ? undefined : { text, failed: true }),
                  )
                : startSession(text));
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
      online={online}
      branches={branches}
      switching={switchingBranch}
      busy={busy}
      onSwitch={(branch) => {
        setSwitchingBranch(true);
        setError("");
        void remoteRequest<HostBranches>(machine.id, "git.switch", {
          projectId: project.projectId,
          branch,
        })
          .then((value) => {
            if (alive.current) setBranches(value);
          })
          .catch((reason) => {
            if (alive.current) setError(String(reason));
          })
          .finally(() => {
            if (alive.current) setSwitchingBranch(false);
            loadBranches();
          });
      }}
      onViewChanges={() => void inspect("git.diff")}
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
  online,
  branches,
  switching,
  busy,
  onSwitch,
  onViewChanges,
}: {
  machine: RemoteMachine;
  project: RemoteProject;
  online: boolean;
  branches?: HostBranches;
  switching: boolean;
  busy: boolean;
  onSwitch: (branch: string) => void;
  onViewChanges: () => void;
}) {
  const anchor = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const canSwitch =
    online && !busy && !switching && !!branches?.branches.length;
  return (
    <>
      <span
        className="flex min-w-0 items-center gap-1.5 text-content/50"
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
      {branches?.current ? (
        <div ref={anchor} className="relative flex min-w-0 shrink">
          <GitPickerTrigger
            title={
              busy
                ? "Wait for the turn to finish to switch branches"
                : "Switch the host checkout’s branch"
            }
            aria-label={`Host branch ${branches.current}`}
            aria-expanded={open}
            aria-haspopup="menu"
            disabled={!canSwitch}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setOpen((value) => !value)}
            label={switching ? "Switching…" : branches.current}
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
              role="menu"
              aria-label="Host branches"
              className="overflow-y-auto p-1"
            >
              {branches.branches.map((branch) => (
                <button
                  key={branch}
                  type="button"
                  role="menuitemradio"
                  aria-checked={branch === branches.current}
                  className="flex h-7.5 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[13px] text-content/75 hover:bg-content/8 hover:text-content"
                  onClick={() => {
                    setOpen(false);
                    if (branch !== branches.current) onSwitch(branch);
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">{branch}</span>
                  {branch === branches.current ? (
                    <Check className="size-3.5 shrink-0 text-content/55" />
                  ) : null}
                </button>
              ))}
            </Popover>
          ) : null}
        </div>
      ) : null}
      <button
        type="button"
        disabled={!online}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onViewChanges}
        className="-ml-1 flex h-6 shrink-0 items-center rounded-md px-1.5 text-[12px] text-content/50 hover:bg-content/8 hover:text-content disabled:opacity-40"
      >
        Changes
      </button>
    </>
  );
}
