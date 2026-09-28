import { useEffect, useRef, useState, type ReactNode } from "react";
import { AgentTranscript } from "../../sessions/ui/AgentTranscript";
import { QuestionForm } from "../../sessions/ui/QuestionForm";
import {
  RUNTIME_MODES,
  RUNTIME_MODE_LABEL,
  type RuntimeMode,
} from "../../sessions/model/session";
import {
  clearPendingRemoteCommand,
  loadRemoteSession,
  pendingRemoteCommand,
  rememberSession,
  rememberRemoteTab,
  rememberWorkspace,
  rememberedSession,
  remoteDraft,
  remoteTabFor,
  remoteRequest,
  savePendingRemoteCommand,
  saveRemoteDraft,
  workspaceFor,
} from "../model/connections";
import {
  carryModelSettings,
  remoteModelControls,
  sameModelSettings,
} from "../model/remoteModels";
import { SearchableSelect } from "../../../shared/ui/SearchableSelect";
import {
  requireHostDescriptor,
  type CommandReceipt,
  type HostCommand,
  type HostDescriptor,
  type HostDirectory,
  type HostBranches,
  type HostModelCatalog,
  type HostProject,
  type HostSession,
  type HostSessionSummary,
  type RemoteMachine,
  type RemoteProvider,
} from "../model/protocol";

const field =
  "rounded-md border border-content/15 bg-background-base p-2 text-[12px] text-content";

/** Remote views deliberately don't mount local workspace hooks. All execution,
 * approval and file actions below explicitly target their owning machine. */
export function RemoteSessionPane({
  machine,
  project,
  shellId,
  machinePicker,
}: {
  machine: RemoteMachine;
  project: string;
  shellId: string;
  machinePicker: ReactNode;
}) {
  const [descriptor, setDescriptor] = useState<HostDescriptor>();
  const [workspace, setWorkspace] = useState(() =>
    workspaceFor(project, machine.environmentId),
  );
  const [path, setPath] = useState("");
  const [directory, setDirectory] = useState<HostDirectory>();
  const [browsing, setBrowsing] = useState(false);
  const [loadedCatalog, setLoadedCatalog] = useState<{
    workspaceId: string;
    value: HostModelCatalog;
  }>();
  const [catalogError, setCatalogError] = useState("");
  const [catalogRefresh, setCatalogRefresh] = useState(0);
  const catalog =
    workspace && loadedCatalog?.workspaceId === workspace.id
      ? loadedCatalog.value
      : undefined;
  const [branches, setBranches] = useState<HostBranches>();
  const [branchChoice, setBranchChoice] = useState("");
  const [switchingBranch, setSwitchingBranch] = useState(false);
  const [sessionId, setSessionId] = useState(() => {
    const tab = remoteTabFor(shellId);
    return tab
      ? tab.sessionId
      : rememberedSession(project, machine.environmentId);
  });
  const [snapshot, setSnapshot] = useState<HostSession>();
  const [online, setOnline] = useState(false);
  const [error, setError] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [pending, setPending] = useState(() =>
    pendingRemoteCommand(project, machine.environmentId, sessionId ?? null),
  );
  const [sending, setSending] = useState(false);
  useEffect(() => {
    setPending(
      pendingRemoteCommand(project, machine.environmentId, sessionId ?? null),
    );
  }, [project, machine.environmentId, sessionId]);
  const sendingRef = useRef(false);
  const [provider, setProvider] = useState<RemoteProvider>("codex");
  const [model, setModel] = useState("");
  const [modelSettings, setModelSettings] = useState<Record<string, string>>(
    {},
  );
  const [mode, setMode] = useState<RuntimeMode>("supervised");
  const draftKey = `${machine.environmentId}:${sessionId ?? "new"}`;
  const [draft, setDraft] = useState(() => remoteDraft(project, draftKey));
  const [preview, setPreview] = useState<{ title: string; text: string }>();
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const [refresh, setRefresh] = useState(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    setDraft(remoteDraft(project, draftKey));
  }, [project, draftKey]);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    let failed = 0;
    // Every request already carries the expected host identity; describe
    // again only after a failure, when the host may have been replaced.
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
        const list = workspace
          ? await remoteRequest<HostSessionSummary[]>(
              machine.id,
              "sessions.list",
              { projectId: workspace.id },
            )
          : [];
        const known =
          snapshotRef.current?.session.id === sessionId
            ? snapshotRef.current
            : undefined;
        const next = sessionId
          ? await loadRemoteSession(machine.id, sessionId, known)
          : undefined;
        if (disposed) return;
        if (next && workspace && next.projectId !== workspace.id) {
          throw new Error("This session belongs to a different host workspace");
        }
        setOnline(true);
        setConnectionError("");
        // A catalog request that failed while offline is retried on recovery.
        if (failed) setCatalogRefresh((value) => value + 1);
        failed = 0;
        setSnapshot(next);
        active =
          !!next?.session.busy ||
          list.some((session) => session.status === "running");
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
              : 3_000,
        );
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [machine.id, machine.environmentId, workspace?.id, sessionId, refresh]);

  useEffect(() => {
    if (
      descriptor?.providers.length &&
      !descriptor.providers.includes(provider)
    ) {
      const next = descriptor.providers[0];
      setProvider(next);
    }
  }, [descriptor, provider]);

  useEffect(() => {
    if (!descriptor || !workspace) return;
    let disposed = false;
    const workspaceId = workspace.id;
    // Keep showing the last catalog while refreshing it.
    void remoteRequest<HostModelCatalog>(machine.id, "models.list", {
      projectId: workspaceId,
    })
      .then((value) => {
        if (disposed) return;
        setLoadedCatalog({ workspaceId, value });
        setCatalogError("");
      })
      .catch((reason) => {
        if (!disposed) setCatalogError(String(reason));
      });
    return () => {
      disposed = true;
    };
  }, [machine.id, descriptor?.environmentId, workspace?.id, catalogRefresh]);

  useEffect(() => {
    if (sessionId || !catalog) return;
    const models = catalog.models[provider] ?? [];
    if (!models.some((entry) => entry.id === model)) {
      setModel(models[0]?.id ?? "");
      setModelSettings(carryModelSettings(models[0]?.settings ?? [], {}));
    }
  }, [catalog, provider, sessionId, model]);

  const browse = async (nextPath?: string) => {
    setBrowsing(true);
    setError("");
    try {
      const next = await remoteRequest<HostDirectory>(
        machine.id,
        "projects.browse",
        {
          path: nextPath,
        },
      );
      if (alive.current) {
        setDirectory(next);
        setPath(next.path);
      }
    } catch (reason) {
      if (alive.current) setError(String(reason));
    } finally {
      if (alive.current) setBrowsing(false);
    }
  };

  useEffect(() => {
    if (!online || workspace || directory) return;
    void browse();
  }, [online, workspace, directory, machine.id]);

  useEffect(() => {
    if (!online || !workspace) return;
    let disposed = false;
    void remoteRequest<HostBranches>(machine.id, "git.branches", {
      projectId: workspace.id,
    })
      .then((value) => {
        if (disposed) return;
        setBranches(value);
        setBranchChoice(value.current ?? "");
      })
      .catch(() => {
        if (!disposed) setBranches(undefined);
      });
    return () => {
      disposed = true;
    };
  }, [online, workspace?.id, machine.id]);

  const selectSession = (id: string) => {
    setSnapshot(undefined);
    setSessionId(id || undefined);
    setPreview(undefined);
    rememberRemoteTab(shellId, machine, id || undefined);
    if (id) rememberSession(project, machine.environmentId, id);
  };

  const run = async (command: HostCommand) => {
    if (sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setError("");
    // Keep the original ID across disconnects and app restarts. An ambiguous
    // response is retried explicitly instead of silently sending a new prompt.
    try {
      savePendingRemoteCommand(project, machine.environmentId, command);
      setPending(command);
      const receipt = await remoteRequest<CommandReceipt>(
        machine.id,
        "commands.dispatch",
        command,
      );
      clearPendingRemoteCommand(
        project,
        machine.environmentId,
        command.commandId,
      );
      const submitted =
        command.type === "send"
          ? command.text
          : command.type === "compact"
            ? "/compact"
            : undefined;
      const submittedSessionId =
        command.type === "send" || command.type === "compact"
          ? command.sessionId
          : undefined;
      if (
        submitted &&
        submittedSessionId &&
        remoteDraft(
          project,
          `${machine.environmentId}:${submittedSessionId}`,
        ) === submitted
      )
        saveRemoteDraft(
          project,
          `${machine.environmentId}:${submittedSessionId}`,
          "",
        );
      if (!alive.current) return;
      setPending(
        pendingRemoteCommand(project, machine.environmentId, sessionId ?? null),
      );
      if (command.type === "create") selectSession(receipt.sessionId);
      if (submitted)
        setDraft((current) => (current === submitted ? "" : current));
      setRefresh((value) => value + 1);
    } catch (reason) {
      if (!alive.current) return;
      const message = String(reason);
      if (message.includes("Host rejected request:")) {
        clearPendingRemoteCommand(
          project,
          machine.environmentId,
          command.commandId,
        );
        setPending(
          pendingRemoteCommand(
            project,
            machine.environmentId,
            sessionId ?? null,
          ),
        );
      }
      setError(message);
    } finally {
      sendingRef.current = false;
      if (alive.current) setSending(false);
    }
  };

  const attachWorkspace = async () => {
    setSending(true);
    setError("");
    try {
      const workspace = await remoteRequest<HostProject>(
        machine.id,
        "projects.open",
        { cwd: path },
      );
      rememberWorkspace(project, machine.environmentId, workspace);
      if (alive.current) setWorkspace(workspace);
    } catch (reason) {
      if (alive.current) setError(String(reason));
    } finally {
      if (alive.current) setSending(false);
    }
  };
  const inspect = async (method: "git.diff" | "files.read", path?: string) => {
    if (!workspace) return;
    try {
      const text = await remoteRequest<string>(machine.id, method, {
        projectId: workspace.id,
        path,
      });
      if (alive.current)
        setPreview({
          title: path ?? "Changes on host",
          text: text || "No tracked changes against HEAD.",
        });
    } catch (reason) {
      if (alive.current) setError(String(reason));
    }
  };

  const session =
    snapshot && snapshot.session.id === sessionId
      ? snapshot.session
      : undefined;
  // Mirror the host's saved settings whenever they change (after Apply, on
  // reopening, or from another desktop). Unapplied local edits are replaced.
  const savedSettings = session?.modelSettings ?? {};
  const savedConfiguration = session
    ? JSON.stringify([
        session.id,
        session.harness,
        session.model,
        session.runtimeMode,
        Object.entries(savedSettings).sort(([a], [b]) => a.localeCompare(b)),
      ])
    : undefined;
  useEffect(() => {
    if (!session) return;
    setProvider(session.harness as RemoteProvider);
    setModel(session.model);
    setModelSettings(session.modelSettings ?? {});
    setMode(session.runtimeMode);
  }, [savedConfiguration]);
  const controls = remoteModelControls(
    catalog,
    provider,
    model,
    session ? savedSettings : {},
    session?.model,
  );
  const selectedModel = controls.model;
  const availableModels = catalog?.models[provider] ?? [];
  // A saved model matched under an older id keeps that id until changed.
  const modelOptions = availableModels.map((entry) => ({
    value: entry === selectedModel ? model : entry.id,
    label: entry.name,
    keywords: entry.nativeId,
  }));
  if (session && !modelOptions.some((option) => option.value === model))
    modelOptions.unshift({
      value: model,
      label: `${model} (${catalog?.models[provider] ? "not listed by host" : "saved"})`,
      keywords: model,
    });
  const settingsChanged =
    !!session &&
    (model !== session.model ||
      mode !== session.runtimeMode ||
      !sameModelSettings(modelSettings, savedSettings));
  // The saved model stays configurable even when the host no longer lists it.
  const canConfigure =
    !!selectedModel || (!!session && model === session.model);
  const catalogProblem = catalog?.errors[provider] ?? catalogError;
  const modelNotice =
    controls.fallback === "unlisted"
      ? `The host no longer lists ${model}. Its saved settings still apply; choose another model to see what the host supports now.`
      : controls.fallback === "no-catalog"
        ? catalogProblem
          ? "Model details are unavailable, so these are this session's saved settings."
          : "Loading model details from the host…"
        : controls.fallback === "saved"
          ? "Some saved settings are no longer described by the host's model list."
          : undefined;
  const modelControls = (
    <>
      <SearchableSelect
        label="Remote model"
        value={model}
        options={modelOptions}
        onChange={(next) => {
          setModel(next);
          setModelSettings(
            next === session?.model
              ? savedSettings
              : carryModelSettings(
                  remoteModelControls(catalog, provider, next, {}).settings,
                  modelSettings,
                ),
          );
        }}
        placeholder={catalog ? "No models available" : "Loading models…"}
        disabled={!catalog || modelOptions.length === 0}
        variant="row"
      />
      {controls.settings.map((setting) => (
        <SearchableSelect
          key={`${model}:${setting.id}`}
          label={setting.label}
          value={modelSettings[setting.id] ?? setting.value}
          options={setting.options}
          onChange={(value) =>
            setModelSettings((current) => ({ ...current, [setting.id]: value }))
          }
          searchable={false}
          variant="row"
        />
      ))}
      <SearchableSelect
        label="Remote permission mode"
        value={mode}
        options={RUNTIME_MODES.map((value) => ({
          value,
          label: RUNTIME_MODE_LABEL[value],
        }))}
        onChange={(value) => setMode(value as RuntimeMode)}
        searchable={false}
        variant="row"
      />
    </>
  );
  const catalogAlert = catalogProblem && (
    <div role="alert" className="text-[12px] text-red-400">
      Could not load models: {catalogProblem}{" "}
      <button
        type="button"
        className="underline"
        onClick={() => setCatalogRefresh((value) => value + 1)}
      >
        Retry
      </button>
    </div>
  );
  const canAct = online && !sending && !pending && !switchingBranch;
  return (
    <div className="flex h-full min-h-0 flex-col text-content">
      <div className="flex flex-wrap items-center gap-3 border-b border-content/10 px-5 py-3 text-[12px]">
        {machinePicker}
        <span className={online ? "text-emerald-400" : "text-content/40"}>
          {online ? "Connected" : "Reconnecting…"}
        </span>
        {workspace && (
          <span
            className="min-w-0 flex-1 truncate text-content/45"
            title={workspace.cwd}
          >
            {session?.title ?? workspace.cwd}
          </span>
        )}
        {workspace && session && (
          <button
            type="button"
            disabled={sending || !!pending}
            onClick={() => selectSession("")}
            className="text-content/60 disabled:opacity-40"
          >
            New session
          </button>
        )}
        {workspace && (
          <button
            disabled={!online}
            onClick={() => void inspect("git.diff")}
            className="text-content/60 disabled:opacity-40"
          >
            View changes
          </button>
        )}
      </div>
      {workspace && branches && branches.branches.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-content/10 px-5 py-2 text-[12px]">
          <SearchableSelect
            label="Host branch"
            value={branchChoice}
            options={branches.branches.map((branch) => ({
              value: branch,
              label: branch,
            }))}
            onChange={setBranchChoice}
            variant="row"
          />
          {branchChoice && branchChoice !== branches.current && (
            <button
              type="button"
              disabled={!online || switchingBranch || !!session?.busy}
              onClick={() => {
                setSwitchingBranch(true);
                setError("");
                void remoteRequest<HostBranches>(machine.id, "git.switch", {
                  projectId: workspace.id,
                  branch: branchChoice,
                })
                  .then((value) => {
                    if (!alive.current) return;
                    setBranches(value);
                    setBranchChoice(value.current ?? "");
                  })
                  .catch((reason) => {
                    if (alive.current) setError(String(reason));
                  })
                  .finally(() => {
                    if (alive.current) setSwitchingBranch(false);
                    void remoteRequest<HostBranches>(
                      machine.id,
                      "git.branches",
                      {
                        projectId: workspace.id,
                      },
                    )
                      .then((value) => {
                        if (alive.current) setBranches(value);
                      })
                      .catch(() => undefined);
                  });
              }}
              className="rounded bg-content/10 px-2 py-1 disabled:opacity-40"
            >
              {switchingBranch ? "Switching…" : "Switch branch"}
            </button>
          )}
          <span className="text-content/40">Shared host checkout</span>
        </div>
      )}
      {(error || connectionError) && (
        <div
          role="alert"
          className="flex items-center gap-3 px-5 py-2 text-[12px] text-red-400"
        >
          <span className="flex-1">{error || connectionError}</span>
          <button
            onClick={() => {
              setError("");
              setConnectionError("");
              setRefresh((value) => value + 1);
              if (catalogProblem || !catalog)
                setCatalogRefresh((value) => value + 1);
            }}
          >
            Retry connection
          </button>
        </div>
      )}
      {pending && (
        <div className="flex items-center gap-3 bg-content/5 px-5 py-3 text-[12px]">
          <span className="flex-1">
            Waiting to confirm the host accepted your request. Retrying will use
            the same request ID.
          </span>
          <button
            disabled={!online || sending}
            onClick={() => void run(pending)}
          >
            {sending ? "Sending…" : "Retry request"}
          </button>
        </div>
      )}
      {!workspace ? (
        // Scroll the whole picker in short panes; centered flex content would
        // otherwise be clipped at the bottom, hiding the last folder rows.
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <form
            className="m-auto flex w-full max-w-lg shrink-0 flex-col gap-3 p-6"
            onSubmit={(event) => {
              event.preventDefault();
              void attachWorkspace();
            }}
          >
            <p className="font-medium">
              Connect this project to {machine.name}
            </p>
            <p className="text-[13px] text-content/50">
              Browse the folders on that machine to choose an existing checkout.
              This links the project selected in your rail.
            </p>
            <div className="flex gap-2">
              <input
                required
                className={`${field} min-w-0 flex-1`}
                aria-label="Project path on host"
                placeholder={
                  descriptor?.platform === "win32"
                    ? "C:\\Users\\me\\code\\my-app"
                    : "/home/me/projects/my-app"
                }
                value={path}
                onChange={(event) => setPath(event.target.value)}
              />
              <button
                type="button"
                disabled={!online || browsing}
                onClick={() => void browse(path || undefined)}
                className="rounded-md bg-content/10 px-3 text-[12px] disabled:opacity-40"
              >
                Browse
              </button>
            </div>
            {directory && (
              <div
                className="max-h-64 overflow-y-auto overscroll-contain rounded-md border border-content/10"
                aria-label="Host folders"
              >
                {/* Padding lives inside the scrolled content so WebKit keeps
                  the last row fully reachable. */}
                <div className="p-1">
                  {directory.parent && (
                    <button
                      type="button"
                      className="block w-full rounded px-2 py-1.5 text-left text-[12px] hover:bg-content/10"
                      onClick={() => void browse(directory.parent!)}
                    >
                      .. Parent folder
                    </button>
                  )}
                  {directory.entries.map((entry) => (
                    <button
                      key={entry.path}
                      type="button"
                      className="block w-full rounded px-2 py-1.5 text-left text-[12px] hover:bg-content/10"
                      onClick={() => void browse(entry.path)}
                    >
                      {entry.name}
                    </button>
                  ))}
                  {!directory.entries.length && (
                    <p className="px-2 py-1.5 text-[12px] text-content/45">
                      No subfolders
                    </p>
                  )}
                </div>
              </div>
            )}
            <button
              disabled={!online || sending}
              className="rounded-md bg-content/10 px-4 py-2 text-[13px] disabled:opacity-40"
            >
              Link workspace
            </button>
          </form>
        </div>
      ) : (
        <>
          {preview ? (
            <div className="flex min-h-0 flex-1 flex-col px-5 pb-4">
              <div className="flex justify-between py-2 text-[12px]">
                <span>{preview.title}</span>
                <button onClick={() => setPreview(undefined)}>
                  Back to session
                </button>
              </div>
              <pre className="min-h-0 flex-1 overflow-auto rounded-lg bg-content/5 p-4 text-[12px] whitespace-pre-wrap">
                {preview.text}
              </pre>
            </div>
          ) : session ? (
            <div className="min-h-0 flex-1 overflow-auto px-5">
              <AgentTranscript
                blocks={session.blocks}
                busy={online && session.busy}
                harness={session.harness}
                model={session.model}
                cwd={session.cwd}
                pendingQuestion={!!session.pendingQuestion}
                backgroundTasks={session.backgroundTasks}
                onOpenFile={
                  online
                    ? (path) => void inspect("files.read", path)
                    : undefined
                }
                onApproval={
                  canAct
                    ? (requestId, decision) =>
                        void run({
                          type: "approve",
                          commandId: crypto.randomUUID(),
                          sessionId: session.id,
                          runId: snapshot!.runId!,
                          requestId,
                          decision,
                        })
                    : undefined
                }
              />
            </div>
          ) : !sessionId ? (
            <div className="m-auto flex w-full max-w-lg flex-col gap-4 p-6">
              <p className="text-[15px]">Start a session on {machine.name}</p>
              <div className="flex flex-wrap gap-2">
                <SearchableSelect
                  label="Remote provider"
                  value={provider}
                  options={(descriptor?.providers ?? []).map((value) => ({
                    value,
                    label: value === "codex" ? "Codex" : "Claude Code",
                  }))}
                  onChange={(value) => setProvider(value as RemoteProvider)}
                  searchable={false}
                  variant="row"
                />
                {modelControls}
              </div>
              {catalogAlert}
              <p className="text-[12px] text-content/45">
                Uses the current checkout and provider account on the host.
                Sessions keep running when you close this app.
              </p>
              {!descriptor?.providers.length && (
                <p className="text-[12px] text-content/50">
                  Install and authenticate Codex or Claude Code on the host,
                  then restart the host.
                </p>
              )}
              <button
                disabled={
                  !canAct ||
                  !descriptor?.providers.includes(provider) ||
                  !selectedModel
                }
                className="rounded-md bg-content/10 p-2 text-[13px] disabled:opacity-40"
                onClick={() =>
                  void run({
                    type: "create",
                    commandId: crypto.randomUUID(),
                    projectId: workspace.id,
                    harness: provider,
                    model,
                    modelSettings,
                    runtimeMode: mode,
                  })
                }
              >
                Create session
              </button>
            </div>
          ) : (
            <div className="m-auto text-[13px] text-content/40">
              Loading session from host…
            </div>
          )}
          {session && (
            <div className="mx-auto w-full max-w-4xl p-4">
              {session.pendingQuestion && canAct && (
                <QuestionForm
                  prompt={session.pendingQuestion}
                  onReply={(requestId, reply) =>
                    void run({
                      type: "answer",
                      commandId: crypto.randomUUID(),
                      sessionId: session.id,
                      runId: snapshot!.runId!,
                      requestId,
                      reply,
                    })
                  }
                />
              )}
              <form
                className="rounded-lg border border-content/15 bg-content/3 p-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (
                    canAct &&
                    !session.busy &&
                    !settingsChanged &&
                    draft.trim()
                  )
                    void run(
                      draft.trim().toLowerCase() === "/compact"
                        ? {
                            type: "compact",
                            commandId: crypto.randomUUID(),
                            sessionId: session.id,
                          }
                        : {
                            type: "send",
                            commandId: crypto.randomUUID(),
                            sessionId: session.id,
                            text: draft,
                          },
                    );
                }}
              >
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  {modelControls}
                  {settingsChanged && (
                    <button
                      type="button"
                      disabled={!canAct || !!session.busy || !canConfigure}
                      className="rounded-md bg-accent/20 px-2.5 py-1.5 text-[12px] disabled:opacity-40"
                      onClick={() =>
                        void run({
                          type: "configure",
                          commandId: crypto.randomUUID(),
                          sessionId: session.id,
                          model,
                          modelSettings,
                          runtimeMode: mode,
                        })
                      }
                    >
                      Apply settings
                    </button>
                  )}
                </div>
                {(modelNotice || catalogProblem || settingsChanged) && (
                  <div className="mb-2 flex flex-col gap-1 text-[12px] text-content/50">
                    {modelNotice && <p>{modelNotice}</p>}
                    {catalogAlert}
                    {settingsChanged && (
                      <p>
                        {session.busy
                          ? "Settings can be applied when this turn finishes."
                          : "Apply settings to use them from the next turn."}
                      </p>
                    )}
                  </div>
                )}
                <textarea
                  aria-label="Message remote agent"
                  placeholder={
                    session.busy
                      ? "Draft a follow-up…"
                      : "What should the agent do?"
                  }
                  rows={3}
                  className="w-full resize-none bg-transparent text-[13px] outline-none"
                  value={draft}
                  onChange={(event) => {
                    setDraft(event.target.value);
                    saveRemoteDraft(project, draftKey, event.target.value);
                  }}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                />
                <div className="flex items-center justify-between text-[12px]">
                  <span className="text-content/40">
                    {machine.name} · {session.harness} ·{" "}
                    {session.busy
                      ? online
                        ? "Running on host"
                        : "Last seen running"
                      : snapshot?.status === "interrupted"
                        ? "Interrupted"
                        : "Ready"}
                  </span>
                  {!session.busy && (
                    <button
                      type="button"
                      disabled={!canAct || !!settingsChanged}
                      className="rounded px-2 py-1.5 text-content/50 hover:bg-content/10 disabled:opacity-40"
                      onClick={() =>
                        void run({
                          type: "compact",
                          commandId: crypto.randomUUID(),
                          sessionId: session.id,
                        })
                      }
                    >
                      Compact context
                    </button>
                  )}
                  {session.busy ? (
                    <button
                      type="button"
                      disabled={!canAct}
                      className="rounded bg-content/10 px-3 py-1.5 disabled:opacity-40"
                      onClick={() =>
                        void run({
                          type: "cancel",
                          commandId: crypto.randomUUID(),
                          sessionId: session.id,
                          runId: snapshot!.runId!,
                        })
                      }
                    >
                      Stop
                    </button>
                  ) : (
                    <button
                      disabled={!canAct || !!settingsChanged || !draft.trim()}
                      className="rounded bg-content/10 px-3 py-1.5 disabled:opacity-40"
                    >
                      Send
                    </button>
                  )}
                </div>
              </form>
            </div>
          )}
        </>
      )}
    </div>
  );
}
