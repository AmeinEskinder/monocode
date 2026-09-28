import { useCallback, useEffect, useRef, useState } from "react";
import { LAYER } from "../../../shared/lib/layers";
import { Popover } from "../../../shared/ui/Popover";
import type { WorkspaceMode } from "../../sessions/model/session";
import {
  isWorkspaceModeShortcut,
  WORKSPACE_MODE_SHORTCUT,
  WorktreeBasePicker,
} from "../../workspace/ui/WorkspacePicker";
import {
  keybindingShortcutLabel,
  keybindingShortcutTokens,
} from "../../settings/model/settings";
import {
  Check,
  ChevronRight,
  Folder,
  FolderTree,
  Loader,
  Settings,
} from "../../../shared/ui/icons";
import { remoteRequest } from "../model/connections";
import type {
  HostBranches,
  HostWorktree,
  HostWorktrees,
  RemoteMachine,
} from "../model/protocol";
import type { RemoteProject } from "../model/remoteProjects";

const HOVER_CLOSE_MS = 100;
const WORKSPACE_SURFACES =
  "[data-workspace-picker],[data-existing-worktrees-submenu]";

export function RemoteWorktreePicker({
  machine,
  project,
  cwd,
  branches,
  mode,
  base,
  online,
  busy,
  allowNewWorktree,
  onSelect,
  onModeChange,
  onBaseChange,
}: {
  machine: RemoteMachine;
  project: RemoteProject;
  cwd: string;
  branches?: HostBranches;
  mode: WorkspaceMode;
  base: string;
  online: boolean;
  busy: boolean;
  allowNewWorktree: boolean;
  onSelect: (tree: HostWorktree) => Promise<void> | void;
  onModeChange: (mode: WorkspaceMode) => void;
  onBaseChange: (base: string) => void;
}) {
  const anchor = useRef<HTMLDivElement>(null);
  const worktreeAnchor = useRef<HTMLButtonElement>(null);
  const closeWorktreeTimer = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [worktreeMenu, setWorktreeMenu] = useState(false);
  const [data, setData] = useState<HostWorktrees>();
  const [error, setError] = useState("");
  const [busyPath, setBusyPath] = useState<string>();
  const shortcut = allowNewWorktree
    ? keybindingShortcutLabel(
        "Composer: Toggle Workspace",
        WORKSPACE_MODE_SHORTCUT,
      )
    : undefined;
  const shortcutTokens = allowNewWorktree
    ? keybindingShortcutTokens(
        "Composer: Toggle Workspace",
        "Meta+Shift+G Control+Shift+G",
      )
    : undefined;

  useEffect(() => {
    if (!allowNewWorktree || !online || busy) return;
    const composer = anchor.current?.closest("[data-composer]");
    if (!composer) return;
    const onKeyDown = (event: Event) => {
      const key = event as KeyboardEvent;
      if (key.isComposing || !isWorkspaceModeShortcut(key)) return;
      if (mode === "current" && !branches?.current) return;
      key.preventDefault();
      key.stopPropagation();
      onModeChange(mode === "current" ? "worktree" : "current");
    };
    composer.addEventListener("keydown", onKeyDown);
    return () => composer.removeEventListener("keydown", onKeyDown);
  }, [allowNewWorktree, online, busy, mode, branches?.current, onModeChange]);

  const load = useCallback(async () => {
    try {
      const value = await remoteRequest<HostWorktrees>(
        machine.id,
        "git.worktrees",
        { projectId: project.projectId },
      );
      setData(value);
      setError("");
    } catch (reason) {
      const message = String(reason);
      setError(
        message.includes("Unsupported host method")
          ? "Update MonoCode Host on this machine to use worktrees."
          : message,
      );
    }
  }, [machine.id, project.projectId]);

  useEffect(() => {
    if (open && worktreeMenu && online) void load();
  }, [open, worktreeMenu, online, load]);
  useEffect(() => {
    if (!online || busy) {
      setOpen(false);
      setWorktreeMenu(false);
    }
  }, [online, busy]);
  useEffect(
    () => () => {
      if (closeWorktreeTimer.current != null)
        window.clearTimeout(closeWorktreeTimer.current);
    },
    [],
  );

  const dismiss = () => {
    if (closeWorktreeTimer.current != null) {
      window.clearTimeout(closeWorktreeTimer.current);
      closeWorktreeTimer.current = null;
    }
    setOpen(false);
    setWorktreeMenu(false);
    setError("");
  };
  const openWorktreeMenu = () => {
    if (closeWorktreeTimer.current != null) {
      window.clearTimeout(closeWorktreeTimer.current);
      closeWorktreeTimer.current = null;
    }
    setWorktreeMenu(true);
  };
  const closeWorktreeMenu = () => {
    if (closeWorktreeTimer.current != null) {
      window.clearTimeout(closeWorktreeTimer.current);
      closeWorktreeTimer.current = null;
    }
    setWorktreeMenu(false);
    setError("");
  };
  const scheduleCloseWorktreeMenu = () => {
    if (closeWorktreeTimer.current != null)
      window.clearTimeout(closeWorktreeTimer.current);
    closeWorktreeTimer.current = window.setTimeout(() => {
      closeWorktreeTimer.current = null;
      setWorktreeMenu(false);
      setError("");
    }, HOVER_CLOSE_MS);
  };

  const select = async (tree: HostWorktree) => {
    if (busyPath || tree.missing) return;
    setBusyPath(tree.path);
    setError("");
    try {
      await onSelect(tree);
      onModeChange("current");
      dismiss();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusyPath(undefined);
    }
  };
  const selectCurrent = () => {
    if (cwd === project.cwd) {
      onModeChange("current");
      dismiss();
      return;
    }
    void select(
      data?.worktrees.find((tree) => tree.path === project.cwd) ?? {
        path: project.cwd,
        branch: null,
        head: "",
        isMain: true,
        missing: false,
      },
    );
  };
  const current = cwd === project.cwd;
  const label =
    mode === "worktree"
      ? "New worktree"
      : current
        ? "Current checkout"
        : "Worktree";
  const worktrees =
    data?.worktrees.filter((tree) => !tree.isMain && !tree.missing) ?? [];

  return (
    <>
      <div ref={anchor} className="relative flex min-w-0 shrink-0">
        <button
          type="button"
          disabled={!online || busy}
          title={
            shortcut
              ? `Workspace: ${label} (${shortcut})`
              : `Workspace: ${label} on ${machine.name}`
          }
          aria-label={`Workspace ${label}`}
          aria-keyshortcuts={shortcutTokens ?? undefined}
          aria-haspopup="dialog"
          aria-expanded={open}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            if (open) dismiss();
            else setOpen(true);
          }}
          className="-ml-1.5 flex h-6 min-w-0 max-w-48 items-center gap-1.5 rounded-md px-1.5 text-[12px] text-content/55 hover:bg-content/8 hover:text-content aria-expanded:bg-content/8 aria-expanded:text-content disabled:opacity-40 disabled:hover:bg-transparent active:scale-[0.97]"
        >
          {mode === "worktree" || !current ? (
            <FolderTree className="size-3.5 shrink-0" />
          ) : (
            <Folder className="size-3.5 shrink-0" />
          )}
          <span className="truncate">{label}</span>
        </button>
        {open ? (
          <Popover
            anchor={anchor}
            side="top"
            width={240}
            constrainHeight={false}
            onDismiss={() => {
              if (!busyPath) dismiss();
            }}
            ignore={WORKSPACE_SURFACES}
            role="dialog"
            aria-label="Workspace"
            data-workspace-picker
            className="overflow-hidden p-1.5"
          >
            <div className="flex items-center justify-between gap-3 px-2 py-1 text-[11px] font-medium text-content/45">
              <span>Workspace</span>
              {shortcut ? (
                <kbd className="font-sans text-[10px] font-normal text-content/35">
                  {shortcut}
                </kbd>
              ) : null}
            </div>
            <button
              type="button"
              aria-pressed={mode === "current" && current}
              disabled={!!busyPath}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={closeWorktreeMenu}
              onClick={selectCurrent}
              className={`flex h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] hover:bg-content/8 ${mode === "current" && current ? "bg-selection text-content" : "text-content/80"}`}
            >
              <Folder className="size-4 shrink-0 text-content/55" />
              <span className="flex-1">Current checkout</span>
              {mode === "current" && current ? (
                <Check className="size-3.5" />
              ) : null}
            </button>
            <button
              type="button"
              aria-pressed={mode === "worktree"}
              disabled={!!busyPath || !allowNewWorktree}
              title={
                allowNewWorktree
                  ? undefined
                  : "Start a new session to create a worktree"
              }
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={closeWorktreeMenu}
              onClick={() => {
                onModeChange("worktree");
                dismiss();
              }}
              className={`flex h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] hover:bg-content/8 disabled:opacity-40 ${mode === "worktree" ? "bg-selection text-content" : "text-content/80"}`}
            >
              <FolderTree className="size-4 shrink-0 text-content/55" />
              <span className="flex-1">New worktree</span>
              {mode === "worktree" ? <Check className="size-3.5" /> : null}
            </button>
            <button
              ref={worktreeAnchor}
              type="button"
              aria-haspopup="menu"
              aria-expanded={worktreeMenu}
              disabled={!!busyPath}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={openWorktreeMenu}
              onMouseLeave={scheduleCloseWorktreeMenu}
              onFocus={openWorktreeMenu}
              onClick={openWorktreeMenu}
              onKeyDown={(event) => {
                if (event.key === "ArrowRight") {
                  event.preventDefault();
                  openWorktreeMenu();
                }
                if (event.key === "ArrowLeft" && worktreeMenu) {
                  event.preventDefault();
                  closeWorktreeMenu();
                }
              }}
              className={`flex h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] text-content/80 hover:bg-content/8 hover:text-content ${worktreeMenu ? "bg-selection text-content" : ""}`}
            >
              <FolderTree className="size-4 shrink-0 text-content/55" />
              <span className="flex-1">Existing worktree…</span>
              <ChevronRight className="size-3.5 shrink-0 text-content/45" />
            </button>
            <div className="h-9 border-t border-stroke">
              <button
                type="button"
                title="Remote worktree settings are not available"
                aria-label="Open worktree settings"
                disabled
                className="flex h-full w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] text-content/35"
              >
                <Settings className="size-4 shrink-0" strokeWidth={1.75} />
                <span className="flex-1">Worktree settings</span>
              </button>
            </div>
          </Popover>
        ) : null}
        {open && worktreeMenu ? (
          <Popover
            anchor={worktreeAnchor}
            side="right"
            gap={4}
            width={300}
            maxHeight={320}
            layer={LAYER.submenu}
            role="menu"
            aria-label="Existing worktrees"
            data-existing-worktrees-submenu
            className="flex flex-col overflow-hidden p-1.5"
            onMouseEnter={openWorktreeMenu}
            onMouseLeave={scheduleCloseWorktreeMenu}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft") {
                event.preventDefault();
                closeWorktreeMenu();
                worktreeAnchor.current?.focus();
              }
            }}
          >
            {!data && !error ? (
              <p className="flex items-center gap-2 px-2 py-3 text-[12px] text-content/50">
                <Loader className="size-3.5 animate-spin" />
                Loading worktrees…
              </p>
            ) : null}
            <div className="min-h-0 overflow-y-auto">
              {worktrees.map((tree) => (
                <button
                  key={tree.path}
                  type="button"
                  role="menuitem"
                  title={tree.path}
                  disabled={!!busyPath}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => void select(tree)}
                  className="flex min-h-11 w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-content/80 hover:bg-content/8 hover:text-content disabled:opacity-40"
                >
                  {busyPath === tree.path ? (
                    <Loader className="size-4 shrink-0 animate-spin text-content/55" />
                  ) : (
                    <FolderTree className="size-4 shrink-0 text-content/55" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px]">
                      {tree.branch ?? `Detached ${tree.head.slice(0, 7)}`}
                    </span>
                    <span className="block truncate font-mono text-[10px] text-content/40">
                      {tree.path}
                    </span>
                  </span>
                </button>
              ))}
              {data && !worktrees.length ? (
                <p className="px-2 py-3 text-[12px] text-content/50">
                  No existing worktrees
                </p>
              ) : null}
            </div>
            {error ? (
              <p
                role="alert"
                className="border-t border-stroke px-2 py-2 text-[11px] text-red-400"
              >
                {error}
              </p>
            ) : null}
          </Popover>
        ) : null}
      </div>
      {mode === "worktree" ? (
        <WorktreeBasePicker
          branches={[
            ...(branches?.branches ?? []).map((name) => ({
              name,
              remote: null,
            })),
            ...(branches?.remotes ?? []),
          ]}
          selected={base}
          loading={!branches}
          enabled={online && !busy && !!branches}
          onChange={onBaseChange}
        />
      ) : null}
    </>
  );
}
